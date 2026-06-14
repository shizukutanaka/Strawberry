// tests/reputation/reputation-scorer.test.js
const { computeReputation, rankProviders, bayesianRate } = require('../../src/reputation/reputation-scorer');

describe('reputation-scorer: computeReputation', () => {
  it('a perfect, well-staked host scores high (gold)', () => {
    const r = computeReputation({
      completedJobs: 500, failedJobs: 0,
      auditPasses: 50, auditFails: 0,
      slaUptimePct: 99.9, interruptionRate: 0.0,
      stake: 5_000_000, slashCount: 0,
    });
    expect(r.score).toBeGreaterThan(0.85);
    expect(r.tier).toBe('gold');
  });

  it('a brand-new host is not gold (Bayesian smoothing + baseline stake factor)', () => {
    const r = computeReputation({});
    expect(r.score).toBeLessThan(0.85);
    expect(['probation', 'bronze', 'silver']).toContain(r.tier);
  });

  it('high failure rate drives the score down', () => {
    const good = computeReputation({ completedJobs: 100, failedJobs: 0, stake: 1_000_000 });
    const bad = computeReputation({ completedJobs: 20, failedJobs: 80, stake: 1_000_000 });
    expect(bad.score).toBeLessThan(good.score);
  });

  it('slashing penalizes the score', () => {
    const base = { completedJobs: 200, failedJobs: 2, auditPasses: 20, auditFails: 0, stake: 2_000_000 };
    const clean = computeReputation({ ...base, slashCount: 0 });
    const slashed = computeReputation({ ...base, slashCount: 2 });
    expect(slashed.score).toBeLessThan(clean.score);
    expect(slashed.components.slashPenalty).toBeGreaterThan(0);
  });

  it('more stake is monotonically better, all else equal', () => {
    const lo = computeReputation({ completedJobs: 100, failedJobs: 0, stake: 0 });
    const mid = computeReputation({ completedJobs: 100, failedJobs: 0, stake: 500_000 });
    const hi = computeReputation({ completedJobs: 100, failedJobs: 0, stake: 5_000_000 });
    expect(mid.score).toBeGreaterThan(lo.score);
    expect(hi.score).toBeGreaterThan(mid.score);
  });

  it('interruptions reduce reliability', () => {
    const stable = computeReputation({ completedJobs: 100, failedJobs: 0, interruptionRate: 0, stake: 1_000_000 });
    const flaky = computeReputation({ completedJobs: 100, failedJobs: 0, interruptionRate: 0.5, stake: 1_000_000 });
    expect(flaky.components.reliability).toBeLessThan(stable.components.reliability);
    expect(flaky.score).toBeLessThan(stable.score);
  });

  it('tolerates non-normalized weights and bad inputs', () => {
    const r = computeReputation(
      { completedJobs: 'oops', failedJobs: null, stake: -100 },
      { weights: { jobSuccess: 2, verification: 2, reliability: 1 } }
    );
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});

describe('reputation-scorer: rankProviders', () => {
  it('sorts providers by score descending', () => {
    const ranked = rankProviders([
      { id: 'weak', stats: { completedJobs: 10, failedJobs: 40, stake: 0 } },
      { id: 'strong', stats: { completedJobs: 300, failedJobs: 1, auditPasses: 30, auditFails: 0, stake: 5_000_000 } },
      { id: 'mid', stats: { completedJobs: 100, failedJobs: 10, stake: 500_000 } },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['strong', 'mid', 'weak']);
  });

  it('throws on non-array input', () => {
    expect(() => rankProviders('nope')).toThrow();
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
