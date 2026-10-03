// src/api/utils/sanitize-user.js — API 応答の機密フィールド除去ポリシーを固定するテスト。
// password/apiKey が外部レスポンスへ露出しないことを保証する認可境界の中核ヘルパー。
// フィールドリストからの誤削除やコピー漏れを回帰で検知する。
const { sanitizeUser, SENSITIVE_USER_FIELDS } = require('../../src/api/utils/sanitize-user');

describe('sanitizeUser', () => {
  it('strips every field in SENSITIVE_USER_FIELDS', () => {
    const user = { id: 'u1', name: 'n' };
    for (const f of SENSITIVE_USER_FIELDS) user[f] = `secret-${f}`;
    const safe = sanitizeUser(user);
    for (const f of SENSITIVE_USER_FIELDS) {
      expect(safe[f]).toBeUndefined();
    }
  });

  it('preserves non-sensitive fields', () => {
    const user = {
      id: 'u1', email: 'a@b.c', role: 'user', rating: 4.5,
      createdAt: '2026-01-01T00:00:00Z', peerId: 'p2p-1',
    };
    const safe = sanitizeUser(user);
    expect(safe).toEqual(user);
  });

  it('does not mutate the input object', () => {
    const user = { id: 'u1', password: 'hashed', apiKey: 'k' };
    sanitizeUser(user);
    expect(user.password).toBe('hashed');
    expect(user.apiKey).toBe('k');
  });

  it('returns non-object inputs unchanged', () => {
    expect(sanitizeUser(null)).toBe(null);
    expect(sanitizeUser(undefined)).toBe(undefined);
    expect(sanitizeUser('x')).toBe('x');
    expect(sanitizeUser(0)).toBe(0);
  });

  it('pins the sensitive field list (regression guard)', () => {
    // リストからの誤ったフィールド削除を検知するため現在のポリシーを固定する。
    // 正当な追加はこのリストを更新して行うこと。
    expect([...SENSITIVE_USER_FIELDS].sort()).toEqual([
      'apiKey',
      'deniedDisputeCount',
      'mfaSecret',
      'password',
      'passwordChangedAt',
      'passwordResetToken',
      'resetToken',
      'sessionsRevokedAt',
      'totpSecret',
      'twoFactorSecret',
      'vindicatedDisputeCount',
    ]);
  });

  it('documents shallow-copy contract: nested objects are not deep-sanitized', () => {
    // sanitizeUser は浅いコピー。ネスト内の同名フィールドは残る契約。
    // （深い除去が必要になった場合はここを変更する）
    const user = { id: 'u1', profile: { password: 'nested' } };
    const safe = sanitizeUser(user);
    expect(safe.profile.password).toBe('nested');
  });
});
