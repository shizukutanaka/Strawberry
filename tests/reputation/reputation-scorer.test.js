// tests/reputation/reputation-scorer.test.js
const { computeReputation, bayesianRate } = require('../../src/reputation/reputation-scorer');

describe('reputation-scorer: computeReputation', () => {
  it('a perfect host scores high (gold)', () => {
    const r = computeReputation({
      completedJobs: 500, failedJobs: 0,
      auditPasses: 50, auditFails: 0,
      slaUptimePct: 99.9, interruptionRate: 0.0,
      slashCount: 0,
    });
    expect(r.score).toBeGreaterThan(0.85);
    expect(r.tier).toBe('gold');
  });

  it('a brand-new host is not gold (Bayesian smoothing)', () => {
    const r = computeReputation({});
    expect(r.score).toBeLessThan(0.85);
    expect(['probation', 'bronze', 'silver']).toContain(r.tier);
  });

  it('high failure rate drives the score down', () => {
    const good = computeReputation({ completedJobs: 100, failedJobs: 0 });
    const bad = computeReputation({ completedJobs: 20, failedJobs: 80 });
    expect(bad.score).toBeLessThan(good.score);
  });

  it('slashing penalizes the score', () => {
    const base = { completedJobs: 200, failedJobs: 2, auditPasses: 20, auditFails: 0 };
    const clean = computeReputation({ ...base, slashCount: 0 });
    const slashed = computeReputation({ ...base, slashCount: 2 });
    expect(slashed.score).toBeLessThan(clean.score);
    expect(slashed.components.slashPenalty).toBeGreaterThan(0);
  });

  // 回帰防止（第9回点検）: 担保ステークの項があった頃は、ステークを預ける経路が製品に
  // 無いため全員 stake=0 で乗数が 0.5 に固定され、どれだけ実績を積んでも score ≤ 0.5
  // だった。tier の閾値（silver 0.65 / gold 0.85）には誰も届かず、UI の「評判」は bronze か
  // probation しか出せなかった。製品が実際に書き込むイベントだけで上位 tier に届くことを固定する。
  it('reaches the top tiers from events the product actually records (no stake exists)', () => {
    const veteran = computeReputation({ completedJobs: 200, failedJobs: 1 });
    expect(veteran.tier).toBe('gold');
    const solid = computeReputation({ completedJobs: 20, failedJobs: 2 });
    expect(['silver', 'gold']).toContain(solid.tier);
    expect(veteran.components).not.toHaveProperty('stakeFactor');
  });

  it('interruptions reduce reliability', () => {
    const stable = computeReputation({ completedJobs: 100, failedJobs: 0, interruptionRate: 0 });
    const flaky = computeReputation({ completedJobs: 100, failedJobs: 0, interruptionRate: 0.5 });
    expect(flaky.components.reliability).toBeLessThan(stable.components.reliability);
    expect(flaky.score).toBeLessThan(stable.score);
  });

  it('tolerates non-normalized weights and bad inputs', () => {
    const r = computeReputation(
      { completedJobs: 'oops', failedJobs: null },
      { weights: { jobSuccess: 2, verification: 2, reliability: 1 } }
    );
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});

describe('reputation-scorer: bayesianRate', () => {
  it('pulls low-sample rates toward the prior', () => {
    expect(bayesianRate(1, 1, { priorMean: 0.8, priorWeight: 5 })).toBeLessThan(1);
    expect(bayesianRate(1000, 1000, { priorMean: 0.8, priorWeight: 5 })).toBeGreaterThan(0.99);
  });

  it('never returns NaN when priorWeight is 0 and total is 0 (user-controlled opts)', () => {
    const r = bayesianRate(0, 0, { priorMean: 0.8, priorWeight: 0 });
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  });

  it('clamps an out-of-range priorMean into [0,1]', () => {
    const r = bayesianRate(0, 0, { priorMean: 5, priorWeight: 5 });
    expect(r).toBeLessThanOrEqual(1);
    expect(r).toBeGreaterThanOrEqual(0);
  });
});
