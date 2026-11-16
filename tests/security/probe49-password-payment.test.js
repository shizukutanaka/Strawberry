// tests/security/probe49-password-payment.test.js
// Probe 49 regression tests:
// 49a: Password change now sets BOTH passwordChangedAt AND sessionsRevokedAt
//      (defense-in-depth: independent invalidation fields stay consistent)

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 49a: password change sets sessionsRevokedAt alongside passwordChangedAt ─
describe('password change: both invalidation fields written', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
  );

  it('user/index.js: password change update sets passwordChangedAt', () => {
    expect(src).toMatch(/password:\s*hashedPassword/);
    expect(src).toMatch(/passwordChangedAt:\s*changedAt/);
  });

  it('user/index.js: password change update ALSO sets sessionsRevokedAt', () => {
    // Anchor on passwordChangedAt (unique to the password-change handler — the
    // registration handler also has a `password: hashedPassword` line).
    const idx = src.indexOf('passwordChangedAt: changedAt');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 600);
    expect(block).toMatch(/sessionsRevokedAt:\s*changedAt/);
  });

  it('user/index.js: both fields use the same changedAt timestamp (consistency)', () => {
    // Newline-agnostic (source files may use CRLF on Windows)
    const m = src.match(/password:\s*hashedPassword,\s*updatedAt:\s*changedAt/);
    expect(m).not.toBeNull();
    const idx = m.index;
    const block = src.slice(idx, idx + 600);
    // Both must reference the single changedAt variable, not separate new Date() calls
    const pwMatch = block.match(/passwordChangedAt:\s*(\w+)/);
    const srMatch = block.match(/sessionsRevokedAt:\s*(\w+)/);
    expect(pwMatch).not.toBeNull();
    expect(srMatch).not.toBeNull();
    expect(pwMatch[1]).toBe(srMatch[1]);
  });

  it('isSessionInvalidated: either field alone invalidates an older token', () => {
    const { isSessionInvalidated } = require('../../src/api/utils/session-invalidation');
    const pastTs = new Date(Date.now() - 60 * 1000).toISOString();
    const oldIat = Math.floor(Date.now() / 1000) - 120;
    // passwordChangedAt only
    expect(isSessionInvalidated({ id: 'a', passwordChangedAt: pastTs }, oldIat)).toBe(true);
    // sessionsRevokedAt only
    expect(isSessionInvalidated({ id: 'b', sessionsRevokedAt: pastTs }, oldIat)).toBe(true);
    // both set (the new password-change behaviour) still invalidates
    expect(isSessionInvalidated({ id: 'c', passwordChangedAt: pastTs, sessionsRevokedAt: pastTs }, oldIat)).toBe(true);
  });
});

// ─── 49b: manual payment approval guarded by withLock ─────────────────────
