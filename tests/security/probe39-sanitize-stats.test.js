// tests/security/probe39-sanitize-stats.test.js
// Probe 39 regression tests:
// 39a: sanitizeString strips null bytes and C0 control characters
// 39b: (removed 2026-09 — GET /marketplace/stats no longer exists)

// ─── 39a: sanitizeString control character stripping ─────────────────────────
describe('sanitizeString: null bytes and C0 control characters are stripped', () => {
  let sanitizeString;
  beforeAll(() => {
    sanitizeString = require('../../src/utils/sanitize').sanitizeString;
  });

  it('strips null bytes', () => {
    const NUL = String.fromCharCode(0);
    const withNull = 'hel' + NUL + 'lo';
    expect(sanitizeString(withNull)).toBe('hello');
    expect(sanitizeString(withNull)).not.toContain(NUL);
  });

  it('strips C0 control characters (0x01 through 0x1f)', () => {
    const withCtrl = 'hel' + String.fromCharCode(1) + String.fromCharCode(10) + String.fromCharCode(31) + 'lo';
    const result = sanitizeString(withCtrl);
    for (let code = 0; code < 32; code++) {
      expect(result).not.toContain(String.fromCharCode(code));
    }
  });

  it('preserves normal printable strings including spaces and hyphens', () => {
    expect(sanitizeString('RTX 3090 GPU')).toBe('RTX 3090 GPU');
    expect(sanitizeString('price-to-rent')).toBe('price-to-rent');
    expect(sanitizeString('hello world!')).toBe('hello world!');
  });

  it('strips HTML tags and residual angle brackets', () => {
    expect(sanitizeString('<script>alert(1)</script>')).toBe('alert(1)');
    expect(sanitizeString('<<tag>')).not.toMatch(/[<>]/);
  });

  it('null byte before tag opener does not bypass HTML stripping', () => {
    const NUL = String.fromCharCode(0);
    const payload = NUL + '<script>xss</script>';
    const result = sanitizeString(payload);
    expect(result).not.toContain(NUL);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('</script>');
  });
});
