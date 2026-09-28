// tests/utils/audit-log-max-mb.test.js
// MAX_AUDIT_LOG_MB がタイポ等で NaN になるとサイズ上限が無言で無効化され、
// ディスク枯渇 DoS が復活する。NaN/負値は既定 50MB へフォールバックすることを固定。
const MB = 1024 * 1024;

function loadMaxBytes(value) {
  if (value === undefined) delete process.env.MAX_AUDIT_LOG_MB;
  else process.env.MAX_AUDIT_LOG_MB = value;
  jest.resetModules();
  return require('../../src/utils/audit-log').MAX_AUDIT_LOG_BYTES;
}

describe('MAX_AUDIT_LOG_MB parsing', () => {
  const saved = process.env.MAX_AUDIT_LOG_MB;
  afterAll(() => {
    if (saved === undefined) delete process.env.MAX_AUDIT_LOG_MB;
    else process.env.MAX_AUDIT_LOG_MB = saved;
    jest.resetModules();
  });

  it('defaults to 50MB when unset or empty', () => {
    expect(loadMaxBytes(undefined)).toBe(50 * MB);
    expect(loadMaxBytes('')).toBe(50 * MB);
  });

  it('falls back to 50MB on NaN (typo) — cap must not silently disable', () => {
    expect(loadMaxBytes('abc')).toBe(50 * MB);
    expect(loadMaxBytes('NaN')).toBe(50 * MB);
    expect(loadMaxBytes('-50x')).toBe(50 * MB);
  });

  it('falls back to 50MB on negative values', () => {
    expect(loadMaxBytes('-10')).toBe(50 * MB);
  });

  it('honours valid values and explicit 0 (freeze)', () => {
    expect(loadMaxBytes('100')).toBe(100 * MB);
    expect(loadMaxBytes('0')).toBe(0);
  });
});
