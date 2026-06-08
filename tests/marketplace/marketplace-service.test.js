// tests/marketplace/marketplace-service.test.js
const { createMarketplaceService } = require('../../src/marketplace/marketplace-service');
const { createEscrowService } = require('../../src/payments/escrow-service');
const { createVerificationService } = require('../../src/verification/verification-service');
const { createReputationService } = require('../../src/reputation/reputation-service');
const { STATES } = require('../../src/payments/escrow-state-machine');

// 汎用インメモリ repo（id 採番 + keyField 検索）
function memRepo(keyField) {
  const rows = new Map();
  let n = 0;
  return {
    create: (rec) => { const id = `${keyField}-${++n}`; const row = { ...rec, id }; rows.set(id, row); return row; },
    getById: (id) => rows.get(id) || null,
    update: (id, u) => { const c = rows.get(id); if (!c) return null; const x = { ...c, ...u }; rows.set(id, x); return x; },
    [keyField === 'job' ? 'getByJobId' : keyField === 'prov' ? 'getByProviderId' : 'getByOrderId']:
      (val) => [...rows.values()].find((r) => r[keyField === 'job' ? 'jobId' : keyField === 'prov' ? 'providerId' : 'orderId'] === val) || null,
  };
}

function build() {
  const escrowService = createEscrowService({ repository: memRepo('e') });
  const verificationService = createVerificationService({ repository: memRepo('job') });
  const reputationService = createReputationService({ repository: memRepo('prov') });
  const mkt = createMarketplaceService({ escrowService, verificationService, reputationService });
  return { mkt, reputationService };
}

const GPU = { vramGB: 80, memBandwidthGBs: 3350, benchmarkScore: 300, generation: 'hopper' };

describe('marketplace-service', () => {
  it('requires all sub-services', () => {
    expect(() => createMarketplaceService({})).toThrow(/required/);
  });

  it('quotes price and scales escrow amount by duration', () => {
    const { mkt } = build();
    const q = mkt.quoteGpu(GPU, { utilization: 0.5 });
    expect(q.pricePerHour).toBeGreaterThan(0);

    const { amountSats, escrow } = mkt.openOrderEscrow({
      orderId: 'o1', providerId: 'p1', gpu: GPU, durationMinutes: 120, market: { utilization: 0.5 },
    });
    expect(amountSats).toBe(Math.round(q.pricePerHour * 2));
    expect(escrow.state).toBe(STATES.PENDING);
  });

  it('happy path: open -> pay -> verify(honest) -> SETTLED + reputation credit', () => {
    const { mkt, reputationService } = build();
    const { escrow } = mkt.openOrderEscrow({ orderId: 'o', providerId: 'p1', gpu: GPU, durationMinutes: 60 });
    mkt.recordPaid(escrow.id);

    const res = mkt.verifyAndSettle({
      jobId: 'job1', escrowId: escrow.id, providerId: 'p1',
      primaryOutput: [1, 2, 3], utilSamples: [80, 90, 85], auditRate: 0,
    });
    expect(res.event).toBe('DELIVER_OK');
    expect(res.escrow.state).toBe(STATES.SETTLED);
    expect(res.actions).toContain('reveal_preimage');
    expect(reputationService.getStats('p1').completedJobs).toBe(1);
  });

  it('fraud path: zero-load -> DISPUTED -> refund slashes provider', () => {
    const { mkt, reputationService } = build();
    const { escrow } = mkt.openOrderEscrow({ orderId: 'o', providerId: 'bad', gpu: GPU, durationMinutes: 60 });
    mkt.recordPaid(escrow.id);

    const res = mkt.verifyAndSettle({
      jobId: 'job2', escrowId: escrow.id, providerId: 'bad',
      primaryOutput: [1], utilSamples: [0, 0, 0, 1], auditRate: 0,
    });
    expect(res.event).toBe('DELIVER_FAIL');
    expect(res.escrow.state).toBe(STATES.DISPUTED);
    expect(reputationService.getStats('bad').failedJobs).toBe(1);

    const slashBefore = reputationService.getStats('bad').slashCount;
    const refund = mkt.resolveDispute(escrow.id, 'refund', 'bad');
    expect(refund.escrow.state).toBe(STATES.CANCELED);
    expect(refund.actions).toContain('refund_renter');
    expect(reputationService.getStats('bad').slashCount).toBe(slashBefore + 1);
  });

  it('ranks candidates by reputation', () => {
    const { mkt, reputationService } = build();
    for (let i = 0; i < 100; i++) reputationService.recordJobResult('strong', true);
    reputationService.addStake('strong', 5_000_000);
    reputationService.recordJobResult('weak', false);
    const ranked = mkt.rankCandidates(['weak', 'strong']);
    expect(ranked[0].id).toBe('strong');
  });

  it('selectProvider runs a reverse auction, auto-filling reputation from the service', () => {
    const { mkt, reputationService } = build();
    // strong provider: many successes + stake; weak: a failure
    for (let i = 0; i < 100; i++) reputationService.recordJobResult('strong', true);
    reputationService.addStake('strong', 5_000_000);
    reputationService.recordJobResult('weak', false);

    // weak bids slightly cheaper but should lose under balanced weights
    const { winner, ranked, rejected } = mkt.selectProvider([
      { providerId: 'strong', pricePerHour: 160, slaUptimePct: 100 },
      { providerId: 'weak', pricePerHour: 150, slaUptimePct: 95 },
    ]);
    expect(winner.providerId).toBe('strong');
    expect(ranked).toHaveLength(2);
    expect(rejected).toHaveLength(0);
    // reputation was auto-filled (not provided in the bids)
    expect(ranked.find((r) => r.providerId === 'strong').components.reputation).toBeGreaterThan(
      ranked.find((r) => r.providerId === 'weak').components.reputation,
    );
  });
});
