// tests/verification/work-verifier.test.js
const { detectZeroLoad } = require('../../src/verification/work-verifier');

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
