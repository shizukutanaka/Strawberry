// tests/unit/session-invalidation-boundary.test.js
// isSessionInvalidated は境界と同じ秒のトークンも拒否する（安全側）。その代償として
// 「パスワード変更 → 同じ秒内に再ログイン」が失敗していた。ログインは境界の秒を
// 跨いでから発行しなければならない。
const { isSessionInvalidated, waitPastInvalidationBoundary } = require('../../src/api/utils/session-invalidation');
const { signAccessToken } = require('../../src/api/utils/tokens');
const jwt = require('jsonwebtoken');

describe('waitPastInvalidationBoundary', () => {
  it('a token issued right after a password change is usable (the login waits past the boundary second)', async () => {
    const user = { id: 'u1', role: 'user', passwordChangedAt: new Date().toISOString() };
    await waitPastInvalidationBoundary(user);
    const token = signAccessToken(user);
    const { iat } = jwt.decode(token);
    expect(isSessionInvalidated(user, iat)).toBe(false);
  });

  it('without the wait, the same-second token would be rejected (documents why the wait exists)', () => {
    const changedAt = new Date();
    const user = { id: 'u1', role: 'user', passwordChangedAt: changedAt.toISOString() };
    const sameSecondIat = Math.floor(changedAt.getTime() / 1000);
    expect(isSessionInvalidated(user, sameSecondIat)).toBe(true);
  });

  it('does not wait when the boundary is already in the past', async () => {
    const user = { id: 'u1', role: 'user', sessionsRevokedAt: new Date(Date.now() - 5000).toISOString() };
    const t0 = Date.now();
    await waitPastInvalidationBoundary(user);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('never waits more than about a second, even for a bogus future timestamp', async () => {
    const user = { id: 'u1', role: 'user', passwordChangedAt: new Date(Date.now() + 60_000).toISOString() };
    const t0 = Date.now();
    await waitPastInvalidationBoundary(user);
    expect(Date.now() - t0).toBeLessThan(1100);
  });

  it('ignores users with no boundary at all', async () => {
    const t0 = Date.now();
    await waitPastInvalidationBoundary({ id: 'u1' });
    await waitPastInvalidationBoundary(null);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
