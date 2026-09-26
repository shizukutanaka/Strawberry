// tests/marketplace/shill-detector.test.js
// src/marketplace/shill-detector.js — 逆オークション談合/シール入札検出の純関数テスト。
// docs/improvement-research-2026.md §17 相当: chronic loser / cover bid / co-bid ring /
// bid rotation の各シグナルとスコア統合、誤検知耐性（正直な競争で flag しない）を検証。
const { detectShills } = require('../../src/marketplace/shill-detector');

// 1オークション分の履歴行を作る。entries: [[providerId, pricePerHour, won], ...]
function auction(auctionId, entries) {
  return entries.map(([providerId, pricePerHour, won]) => ({
    auctionId,
    providerId,
    pricePerHour,
    won: won === true,
    eligible: true,
  }));
}

function mergeAll(...auctions) {
  return auctions.flat();
}

describe('shill-detector', () => {
  it('returns empty result for empty or trivial history', () => {
    const r = detectShills([]);
    expect(r.flagged).toEqual([]);
    expect(r.suspicions).toEqual([]);
    expect(r.pairs).toEqual([]);
  });

  it('rejects non-array input and skips malformed rows', () => {
    expect(() => detectShills('nope')).toThrow(/array/);
    const r = detectShills([
      { providerId: 'p1', pricePerHour: 10 }, // auctionId 欠落
      { auctionId: 'a1', pricePerHour: 10 },  // providerId 欠落
      { auctionId: 'a1', providerId: 'p1', pricePerHour: 100, won: true },
      { auctionId: 'a1', providerId: 'p2', pricePerHour: 120 },
    ]);
    expect(r.suspicions).toEqual([]); // 参加1回では判定しない
  });

  it('does not flag honest competitive bidding', () => {
    // 4者が交互に勝ち、価格も上下する健全な競争
    const h = mergeAll(
      auction('a1', [['A', 100, true], ['B', 95], ['C', 105], ['D', 90]]),
      auction('a2', [['A', 98], ['B', 92, true], ['C', 101], ['D', 97]]),
      auction('a3', [['A', 99], ['B', 96], ['C', 94, true], ['D', 103]]),
      auction('a4', [['A', 95], ['B', 104], ['C', 100], ['D', 91, true]]),
      auction('a5', [['A', 97, true], ['B', 99], ['C', 96], ['D', 93]]),
    );
    const r = detectShills(h);
    expect(r.flagged).toEqual([]);
    // D は 5戦1勝(winRate .2 > .15)で常敗閾値を満たさず、価格も勝者の±で分散
    expect(r.suspicions.filter((s) => s.flagged)).toEqual([]);
  });

  it('flags a chronic loser who always places cover bids just above the winner', () => {
    // SHILL は毎回 W の勝者価格の ~10%上に入札し、自らは一切勝たない。
    // なお W が勝たないオークション（x1）には参加しない＝受益者相関の選択的共演。
    // X は W の勝利にもそれ以外にも一律参加する高値の常敗者（談合ではない）。
    const h = mergeAll(
      auction('a1', [['W', 100, true], ['SHILL', 110], ['X', 95]]),
      auction('a2', [['W', 102, true], ['SHILL', 112], ['X', 99]]),
      auction('a3', [['W', 98, true], ['SHILL', 108], ['X', 96]]),
      auction('a4', [['W', 100, true], ['SHILL', 111], ['X', 97]]),
      auction('a5', [['W', 101, true], ['SHILL', 112], ['X', 98]]),
      // W が勝たないオークション: SHILL は不参加（選択性）、X は参加するが高値で敗北
      auction('x1', [['Z', 90, true], ['X', 130]]),
    );
    const r = detectShills(h);
    const shill = r.suspicions.find((s) => s.providerId === 'SHILL');
    expect(shill).toBeDefined();
    const types = shill.signals.map((s) => s.type);
    expect(types).toContain('chronic_loser');
    expect(types).toContain('cover_bidder');
    expect(types).toContain('dedicated_co_bidder');
    expect(r.flagged).toContain('SHILL');
    // 受益者として W に propped_winner が付く（単独では flag しない）
    const w = r.suspicions.find((s) => s.providerId === 'W');
    expect(w).toBeDefined();
    expect(w.signals.map((s) => s.type)).toContain('propped_winner');
    expect(w.flagged).toBe(false);
    // X: 常敗だが勝者より安値（実力負け）かつ無選択 → chronic_loser のみで flag されない
    const x = r.suspicions.find((s) => s.providerId === 'X');
    expect(x.signals.map((s) => s.type)).toEqual(['chronic_loser']);
    expect(x.flagged).toBe(false);
  });

  it('detects a bid-rotation pair splitting wins between two co-participants', () => {
    // R1/R2 が共演オークションを交互に分け合う（第三者 W は一切勝てない）
    const h = mergeAll(
      auction('a1', [['R1', 100, true], ['R2', 120], ['W', 90]]),
      auction('a2', [['R1', 118], ['R2', 99, true], ['W', 92]]),
      auction('a3', [['R1', 101, true], ['R2', 121], ['W', 89]]),
      auction('a4', [['R1', 119], ['R2', 98, true], ['W', 91]]),
      // ペア以外のオークション（外挿: 第三者同士の競争）
      auction('x1', [['W', 80, true], ['Q', 82]]),
    );
    const r = detectShills(h);
    const pair = r.pairs.find((p) => [p.a, p.b].sort().join(',') === 'R1,R2');
    expect(pair).toBeDefined();
    expect(pair.sharedAuctions).toBe(4);
    expect(pair.winsInside).toBe(4);
    expect(r.flagged).toEqual(expect.arrayContaining(['R1', 'R2']));
  });

  it('needs multiple corroborating signals to flag (single weak signal stays unflagged)', () => {
    // C はたまたま4連敗したが入札価格は勝者より下（実力負け）→ chronic_loser のみ
    const h = mergeAll(
      auction('a1', [['W1', 100, true], ['C', 90]]),
      auction('a2', [['W2', 105, true], ['C', 91]]),
      auction('a3', [['W3', 99, true], ['C', 88]]),
      auction('a4', [['W4', 103, true], ['C', 92]]),
    );
    const r = detectShills(h);
    const c = r.suspicions.find((s) => s.providerId === 'C');
    expect(c).toBeDefined();
    expect(c.signals.map((s) => s.type)).toEqual(['chronic_loser']);
    expect(c.flagged).toBe(false);
    expect(r.flagged).toEqual([]);
  });

  it('honors threshold/weight overrides', () => {
    // S は毎回異なる勝者の直ぐ上にカバー入札 → chronic_loser(0.35)+cover_bidder(0.35)=0.7
    // （単一勝者への常時共演ではないため dedicated_co_bidder は付かない）
    const h = mergeAll(
      auction('a1', [['W1', 100, true], ['S', 110]]),
      auction('a2', [['W2', 102, true], ['S', 112]]),
      auction('a3', [['W3', 98, true], ['S', 108]]),
      auction('a4', [['W4', 100, true], ['S', 111]]),
    );
    const base = detectShills(h);
    expect(base.flagged).toContain('S'); // 0.7 >= 0.5
    // flagScore を 0.9 に上げると 0.7 では flag されない
    const r = detectShills(h, { flagScore: 0.9 });
    expect(r.flagged).toEqual([]);
    // minParticipations を上げると参加4回では chronic_loser すら付かない
    const r2 = detectShills(h, { minParticipations: 10 });
    expect(r2.suspicions).toEqual([]);
  });
});
