// tests/security/probe48-totp-session-invalidation.test.js
// Probe 48 regression tests:
// 48a: TOTP code reuse within same 30-second window now rejected (counter tracked in session)
// 48b: Future passwordChangedAt/sessionsRevokedAt no longer bypasses session invalidation
// 48c: Same counter tracking prevents multi-window replay (window:1 OK for clock drift)

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 48b: future timestamp bypass fixed in isSessionInvalidated ───────────
describe('isSessionInvalidated: future cutoff timestamps rejected', () => {
  const { isSessionInvalidated } = require('../../src/api/utils/session-invalidation');

  it('future passwordChangedAt does NOT invalidate a recently-issued token', () => {
    const futureTs = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const user = { id: 'u1', passwordChangedAt: futureTs };
    const recentIat = Math.floor(Date.now() / 1000) - 60; // issued 60s ago
    // A future cutoff must NOT invalidate a legitimately-issued recent token
    expect(isSessionInvalidated(user, recentIat)).toBe(false);
  });

  it('future sessionsRevokedAt does NOT invalidate current session', () => {
    const futureTs = new Date(Date.now() + 86400000).toISOString();
    const user = { id: 'u2', sessionsRevokedAt: futureTs };
    const iat = Math.floor(Date.now() / 1000) - 10;
    expect(isSessionInvalidated(user, iat)).toBe(false);
  });

  it('past passwordChangedAt DOES invalidate older token (base case still works)', () => {
    const pastTs = new Date(Date.now() - 60 * 1000).toISOString(); // 60s ago
    const user = { id: 'u3', passwordChangedAt: pastTs };
    const oldIat = Math.floor(Date.now() / 1000) - 120; // issued 120s ago (before change)
    expect(isSessionInvalidated(user, oldIat)).toBe(true);
  });

  it('past passwordChangedAt does NOT invalidate newer token', () => {
    const pastTs = new Date(Date.now() - 60 * 1000).toISOString(); // changed 60s ago
    const user = { id: 'u4', passwordChangedAt: pastTs };
    const newIat = Math.floor(Date.now() / 1000) - 10; // issued 10s ago (after change)
    expect(isSessionInvalidated(user, newIat)).toBe(false);
  });

  it('NaN iat always invalidated (fail-closed)', () => {
    const user = { id: 'u5' };
    expect(isSessionInvalidated(user, NaN)).toBe(true);
    expect(isSessionInvalidated(user, Infinity)).toBe(true);
  });
});

// ─── 48a+48c: TOTP counter tracking in master-auth ───────────────────────
describe('master-auth TOTP: code reuse prevention', () => {
  it('master-auth.js: lastTotpCounter stored in session after successful TOTP', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/master-auth.js'), 'utf-8'
    );
    expect(src).toMatch(/lastTotpCounter/);
    expect(src).toMatch(/req\.session\.lastTotpCounter\s*=/);
  });

  it('master-auth.js: duplicate counter rejected before verifyTOTP call', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/master-auth.js'), 'utf-8'
    );
    // The counter check must come BEFORE verifyTOTP to prevent timing oracle
    const counterCheckIdx = src.indexOf('lastTotpCounter === currentTotpCounter');
    const verifyIdx = src.indexOf('verifyTOTP(');
    expect(counterCheckIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(counterCheckIdx).toBeLessThan(verifyIdx);
  });

  it('master-auth.js: currentTotpCounter uses 30-second window (floor(now/30))', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/master-auth.js'), 'utf-8'
    );
    expect(src).toMatch(/Math\.floor\(Date\.now\(\)\s*\/\s*1000\s*\/\s*30\)/);
  });

  it('TOTP counter math: same code in same 30s window has identical counter', () => {
    const now = Date.now();
    const counter1 = Math.floor(now / 1000 / 30);
    const counter2 = Math.floor((now + 5000) / 1000 / 30); // 5 seconds later, same window
    expect(counter1).toBe(counter2);
  });

  it('TOTP counter math: code in next 30s window has different counter', () => {
    const now = Date.now();
    const windowBoundary = Math.ceil(now / 30000) * 30000; // start of next window
    const counter1 = Math.floor(now / 1000 / 30);
    const counter2 = Math.floor(windowBoundary / 1000 / 30);
    expect(counter2).toBeGreaterThan(counter1);
  });
});
