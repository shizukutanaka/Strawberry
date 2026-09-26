const { masterSessionOptions } = require('../../../src/api/middleware/master-session');

describe('master-session config', () => {
  it('bounds the elevated session with an absolute TTL', () => {
    const { maxAge } = masterSessionOptions.cookie;
    expect(Number.isFinite(maxAge)).toBe(true);
    expect(maxAge).toBeGreaterThan(0);
    // 昇格セッションは長くても 1 時間以内に失効する
    expect(maxAge).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('keeps the hardened cookie attributes', () => {
    expect(masterSessionOptions.cookie.httpOnly).toBe(true);
    expect(masterSessionOptions.cookie.sameSite).toBe('strict');
    expect(masterSessionOptions.resave).toBe(false);
    expect(masterSessionOptions.saveUninitialized).toBe(false);
  });
});
