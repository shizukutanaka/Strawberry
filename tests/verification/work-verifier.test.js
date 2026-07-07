// tests/verification/work-verifier.test.js
const {
  shouldAudit,
  outputsMatch,
  ternaryConsensus,
  detectZeroLoad,
} = require('../../src/verification/work-verifier');

describe('work-verifier: shouldAudit', () => {
  it('is deterministic for the same jobId', () => {
    const a = shouldAudit('job-123', { auditRate: 0.5 });
    const b = shouldAudit('job-123', { auditRate: 0.5 });
    expect(a).toBe(b);
  });

  it('auditRate 0 never audits, 1 always audits', () => {
    expect(shouldAudit('any', { auditRate: 0 })).toBe(false);
    expect(shouldAudit('any', { auditRate: 1 })).toBe(true);
  });

  it('selects roughly auditRate fraction across many jobs', () => {
    const N = 2000;
    let audited = 0;
    for (let i = 0; i < N; i++) {
      if (shouldAudit(`job-${i}`, { auditRate: 0.25 })) audited++;
    }
    const frac = audited / N;
    expect(frac).toBeGreaterThan(0.2);
    expect(frac).toBeLessThan(0.3);
  });

  it('throws on invalid input', () => {
    expect(() => shouldAudit('', { auditRate: 0.1 })).toThrow();
    expect(() => shouldAudit('x', { auditRate: 2 })).toThrow();
  });
});

describe('work-verifier: outputsMatch', () => {
  it('matches numbers within relative tolerance (GPU nondeterminism)', () => {
    expect(outputsMatch(1.0, 1.0005, { tolerance: 1e-3 })).toBe(true);
    expect(outputsMatch(1.0, 1.5, { tolerance: 1e-3 })).toBe(false);
  });

  it('compares nested numeric arrays elementwise', () => {
    expect(outputsMatch([1, [2, 3]], [1.0001, [2.0001, 3.0]], { tolerance: 1e-3 })).toBe(true);
    expect(outputsMatch([1, 2], [1, 2, 3])).toBe(false);
  });

  it('handles NaN and exact non-numeric', () => {
    expect(outputsMatch(NaN, NaN)).toBe(true);
    expect(outputsMatch(NaN, 1)).toBe(false);
    expect(outputsMatch('hashA', 'hashA')).toBe(true);
    expect(outputsMatch('hashA', 'hashB')).toBe(false);
  });
});

describe('work-verifier: ternaryConsensus', () => {
  it('agrees when a majority cluster exists and flags dissenters', () => {
    const r = ternaryConsensus([1.0, 1.0001, 9.9], { tolerance: 1e-3 });
    expect(r.agreed).toBe(true);
    expect(r.value).toBeCloseTo(1.0);
    expect(r.dissenters).toEqual([2]);
  });

  it('does not agree when all outputs differ', () => {
    const r = ternaryConsensus([1, 5, 9], { tolerance: 1e-6 });
    expect(r.agreed).toBe(false);
    expect(r.value).toBeNull();
  });

  it('requires at least 3 outputs', () => {
    expect(() => ternaryConsensus([1, 1])).toThrow();
  });
});

describe('work-verifier: detectZeroLoad', () => {
  it('flags suspected zero-load when utilization stays near zero', () => {
    const r = detectZeroLoad([0, 1, 0, 0, 2, 0], { minUtilPct: 5, minActiveRatio: 0.2 });
    expect(r.suspectedZeroLoad).toBe(true);
  });

  it('does not flag a genuinely busy GPU', () => {
    const r = detectZeroLoad([80, 75, 90, 60, 88], { minUtilPct: 5, minActiveRatio: 0.2 });
    expect(r.suspectedZeroLoad).toBe(false);
    expect(r.activeRatio).toBe(1);
  });

  it('throws on empty samples', () => {
    expect(() => detectZeroLoad([])).toThrow();
  });
});
