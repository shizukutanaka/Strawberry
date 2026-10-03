// src/api/utils/session-invalidation.js — トークン無効化境界の契約を直接固定するテスト。
// REST(jwt-auth/security)・GraphQL・/refresh の4箇所が共有する一元ポリシー。
// `<`/`<=` 境界・未来タイムスタンプのスキューガード・NaN iat の fail-closed は
// 「無効化漏れ」または「全トークン永続失効」のどちらへも倒れ得ない重要不変条件。
const { isSessionInvalidated } = require('../../src/api/utils/session-invalidation');

const NOW_S = Math.floor(Date.now() / 1000);
const iso = (secAgo) => new Date(Date.now() - secAgo * 1000).toISOString();
const isoAhead = (secAhead) => new Date(Date.now() + secAhead * 1000).toISOString();

describe('isSessionInvalidated', () => {
  it('returns false for a null/missing user', () => {
    expect(isSessionInvalidated(null, NOW_S)).toBe(false);
    expect(isSessionInvalidated(undefined, NOW_S)).toBe(false);
  });

  it('rejects non-finite iat (fail-closed)', () => {
    const user = {};
    expect(isSessionInvalidated(user, NaN)).toBe(true);
    expect(isSessionInvalidated(user, Infinity)).toBe(true);
    expect(isSessionInvalidated(user, 'abc')).toBe(true);
  });

  it('invalidates tokens issued at or before the cutoff (iat <= cutoff)', () => {
    const user = { sessionsRevokedAt: iso(60) };
    const cutoff = Math.floor(Date.parse(user.sessionsRevokedAt) / 1000);
    expect(isSessionInvalidated(user, cutoff - 1)).toBe(true);
    expect(isSessionInvalidated(user, cutoff)).toBe(true); // 同一秒も無効（<= 契約）
    expect(isSessionInvalidated(user, cutoff + 1)).toBe(false);
  });

  it('passwordChangedAt and sessionsRevokedAt each independently invalidate', () => {
    const iat = NOW_S - 120;
    expect(isSessionInvalidated({ passwordChangedAt: iso(60) }, iat)).toBe(true);
    expect(isSessionInvalidated({ sessionsRevokedAt: iso(60) }, iat)).toBe(true);
    expect(isSessionInvalidated({ passwordChangedAt: iso(3600) }, iat)).toBe(false);
    expect(isSessionInvalidated({}, iat)).toBe(false);
  });

  it('ignores future cutoffs (clock skew / polluted data must not lock out all tokens)', () => {
    const user = { sessionsRevokedAt: isoAhead(3600) };
    // 未来の cutoff が適用されると iat <= cutoff が常に真 → 全トークン永続失効。
    // ガードにより無視され、発行直後のトークンは有効のまま。
    expect(isSessionInvalidated(user, NOW_S)).toBe(false);
  });

  it('ignores unparseable cutoff values', () => {
    const user = { sessionsRevokedAt: 'not-a-date', passwordChangedAt: 12345 };
    expect(isSessionInvalidated(user, NOW_S)).toBe(false);
  });

  it('invalidates when either field triggers (mixed past/future)', () => {
    // sessionsRevokedAt が未来（無視）でも passwordChangedAt の過去カットオフは効く
    const user = { sessionsRevokedAt: isoAhead(3600), passwordChangedAt: iso(60) };
    expect(isSessionInvalidated(user, NOW_S - 120)).toBe(true);
  });
});
