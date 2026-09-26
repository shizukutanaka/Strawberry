const { safeTokenEqual } = require('../../src/utils/safe-compare');

describe('safeTokenEqual', () => {
  it('returns true for identical secrets', () => {
    expect(safeTokenEqual('metrics-token-abc123', 'metrics-token-abc123')).toBe(true);
  });

  it('returns false for different secrets of the same length', () => {
    expect(safeTokenEqual('metrics-token-abc123', 'metrics-token-abc124')).toBe(false);
  });

  it('returns false for different lengths without throwing (no length leak)', () => {
    expect(safeTokenEqual('short', 'a-much-longer-secret-value')).toBe(false);
    expect(safeTokenEqual('a-much-longer-secret-value', 'short')).toBe(false);
  });

  it('coerces non-string inputs and never throws', () => {
    expect(safeTokenEqual(12345, '12345')).toBe(true);
    expect(safeTokenEqual(Buffer.from('tok'), 'tok')).toBe(true);
    expect(safeTokenEqual(null, 'tok')).toBe(false);
    expect(safeTokenEqual('tok', undefined)).toBe(false);
    expect(safeTokenEqual({}, 'tok')).toBe(false);
  });

  it('never authenticates on empty strings (missing expected secret)', () => {
    expect(safeTokenEqual('', '')).toBe(false);
    expect(safeTokenEqual('', 'real')).toBe(false);
    expect(safeTokenEqual('real', '')).toBe(false);
  });

  it('is deterministic across repeated calls (fresh nonce per call does not change result)', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(safeTokenEqual('a', 'a')).toBe(true);
      expect(safeTokenEqual('a', 'b')).toBe(false);
    }
  });
});
