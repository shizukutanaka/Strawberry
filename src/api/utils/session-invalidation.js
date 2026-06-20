// src/api/utils/session-invalidation.js
// トークン無効化判定の一元化。アクセス/リフレッシュトークンは、ユーザーが
//   1) パスワードを変更した (passwordChangedAt)、または
//   2) リフレッシュトークン再利用検知などで全セッションを失効させた (sessionsRevokedAt)
// 時点 *以前* に発行されたものは拒否する。REST(jwt-auth.js / security.js)・GraphQL・
// /refresh の4箇所で同一ポリシーを使うため、ここに集約する（< と <= の取り違えや
// 片方の条件の付け忘れといった食い違いを防ぐ）。
//
// 比較は `<=`（同一秒内に発行されたトークンも無効化する）。Date.parse が NaN を返す
// 不正値は Number.isFinite で弾き、フェイルオープン（無効化漏れ）を防ぐ。

/**
 * 指定 iat（発行時刻・エポック秒）のトークンが、当該ユーザーのセッション無効化境界
 * より前（または同一秒）に発行されていれば true（=拒否すべき）。
 * @param {object|null} user - UserRepository のユーザー（passwordChangedAt / sessionsRevokedAt を含み得る）
 * @param {number} iat - JWT の iat（秒）
 * @returns {boolean}
 */
function isSessionInvalidated(user, iat) {
  if (!user) return false;
  if (!Number.isFinite(iat)) return true; // NaN/Infinity iat is suspicious — reject
  for (const field of ['passwordChangedAt', 'sessionsRevokedAt']) {
    const ts = user[field];
    if (!ts) continue;
    const cutoff = Math.floor(Date.parse(ts) / 1000);
    if (Number.isFinite(cutoff) && iat <= cutoff) return true;
  }
  return false;
}

module.exports = { isSessionInvalidated };
