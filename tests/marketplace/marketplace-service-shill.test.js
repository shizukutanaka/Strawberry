// tests/marketplace/marketplace-service-shill.test.js
// marketplace-service の談合検出配線テスト:
// 入札履歴の永続化、selectProvider の {auctionId, flagged, suspicions} 返却、
// enforceShillSlash（reputation slash）と excludeFlagged（事前 flag の入札除外）、
// 検出系障害がオークション結果をマスクしないこと。
const { createMarketplaceService } = require('../../src/marketplace/marketplace-service');
const { createEscrowService } = require('../../src/payments/escrow-service');
const { createVerificationService } = require('../../src/verification/verification-service');
const { createReputationService } = require('../../src/reputation/reputation-service');

// 汎用インメモリ repo（marketplace-service.test.js と同じ簡易実装）
function memRepo(keyField) {
  const rows = new Map();
  let n = 0;
  return {
    create: (rec) => { const id = `${keyField}-${++n}`; const row = { ...rec, id }; rows.set(id, row); return row; },
    getById: (id) => rows.get(id) || null,
    getAll: () => [...rows.values()],
    update: (id, u) => { const c = rows.get(id); if (!c) return null; const x = { ...c, ...u }; rows.set(id, x); return x; },
    [keyField === 'job' ? 'getByJobId' : keyField === 'prov' ? 'getByProviderId' : 'getByOrderId']:
      (val) => [...rows.values()].find((r) => r[keyField === 'job' ? 'jobId' : keyField === 'prov' ? 'providerId' : 'orderId'] === val) || null,
    getByAuctionId: (val) => [...rows.values()].filter((r) => r.auctionId === val),
  };
}

function build(bidRepository) {
  const escrowService = createEscrowService({ repository: memRepo('e') });
  const verificationService = createVerificationService({ repository: memRepo('job') });
  const reputationService = createReputationService({ repository: memRepo('prov') });
  const mkt = createMarketplaceService({
    escrowService,
    verificationService,
    reputationService,
    bidRepository,
  });
  return { mkt, reputationService, bidRepository };
}

// 勝者 W に対し SHILL が毎回カバー入札を置くオークションを n 回実行する。
// （selectProvider は内部で入札を記録→横断検出するため、繰り返し呼ぶだけで履歴が溜まる）
function runShillAuctions(mkt, n) {
  const weights = { price: 1, reputation: 0, sla: 0, attestation: 0 }; // 最安値が勝つ
  for (let i = 0; i < n; i++) {
    mkt.selectProvider(
      [
        { providerId: 'W', pricePerHour: 100 },
        { providerId: 'SHILL', pricePerHour: 110 }, // 勝者の ~10% 上のカバー入札
        { providerId: 'X', pricePerHour: 130 },     // 健全な高値入札（カバー範囲外）
      ],
      { weights },
    );
  }
}

describe('marketplace-service shill detection', () => {
  it('records every bid and returns auctionId/flagged/suspicions', () => {
    const bids = memRepo('bid');
    const { mkt } = build(bids);
    const r = mkt.selectProvider([
      { providerId: 'a', pricePerHour: 100, reputationScore: 0.9 },
      { providerId: 'b', pricePerHour: 90, reputationScore: 0.9 },
    ]);
    expect(typeof r.auctionId).toBe('string');
    expect(r.flagged).toEqual([]);
    expect(r.suspicions).toEqual([]);
    expect(r.winner.providerId).toBeDefined();
    const stored = bids.getByAuctionId(r.auctionId);
    expect(stored).toHaveLength(2);
    const winnerRow = stored.find((x) => x.won);
    expect(winnerRow.providerId).toBe(r.winner.providerId);
  });

  it('flags a persistent cover bidder after enough auctions and annotates ranked rows', () => {
    const bids = memRepo('bid');
    const { mkt } = build(bids);
    runShillAuctions(mkt, 4);
    const r = mkt.selectProvider(
      [
        { providerId: 'W', pricePerHour: 100 },
        { providerId: 'SHILL', pricePerHour: 110 },
        { providerId: 'X', pricePerHour: 130 },
      ],
      { weights: { price: 1, reputation: 0, sla: 0, attestation: 0 } },
    );
    expect(r.flagged).toContain('SHILL');
    expect(r.flagged).not.toContain('X');
    const shillRow = r.ranked.find((x) => x.providerId === 'SHILL');
    expect(shillRow.suspicion.flagged).toBe(true);
    expect(shillRow.suspicion.signals).toEqual(expect.arrayContaining(['chronic_loser', 'cover_bidder']));
  });

  it('enforceShillSlash slashes flagged providers in reputation', () => {
    const bids = memRepo('bid');
    const { mkt, reputationService } = build(bids);
    runShillAuctions(mkt, 4);
    const before = reputationService.getStats('SHILL').slashCount || 0;
    mkt.selectProvider(
      [
        { providerId: 'W', pricePerHour: 100 },
        { providerId: 'SHILL', pricePerHour: 110 },
      ],
      { weights: { price: 1, reputation: 0, sla: 0, attestation: 0 }, enforceShillSlash: true },
    );
    expect((reputationService.getStats('SHILL').slashCount || 0)).toBe(before + 1);
  });

  it('excludeFlagged rejects previously flagged bidders from subsequent auctions', () => {
    const bids = memRepo('bid');
    const { mkt } = build(bids);
    runShillAuctions(mkt, 4); // SHILL が flag される
    const r = mkt.selectProvider(
      [
        { providerId: 'W', pricePerHour: 100 },
        { providerId: 'SHILL', pricePerHour: 90 }, // 最安値でも flag 済みなら除外
      ],
      { weights: { price: 1, reputation: 0, sla: 0, attestation: 0 }, excludeFlagged: true },
    );
    expect(r.winner.providerId).toBe('W');
    expect(r.rejected.find((x) => x.providerId === 'SHILL').reasons).toContain('marked ineligible');
  });

  it('keeps the auction working when bid persistence or detection fails', () => {
    const badRepo = {
      getAll: () => { throw new Error('corrupt'); },
      getByAuctionId: () => [],
      create: () => { throw new Error('disk full'); },
    };
    const { mkt } = build(badRepo);
    const r = mkt.selectProvider([
      { providerId: 'a', pricePerHour: 100, reputationScore: 0.9 },
      { providerId: 'b', pricePerHour: 90, reputationScore: 0.9 },
    ]);
    expect(r.winner.providerId).toBe('b');
    expect(r.flagged).toEqual([]);
  });
});
