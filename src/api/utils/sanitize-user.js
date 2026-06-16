// src/api/utils/sanitize-user.js
// ユーザーオブジェクトから機密フィールドを除いた「公開可能」な形を返す共通ヘルパー。
//
// password / apiKey は外部レスポンスに絶対に含めてはならない。これまで各エンドポイントが
// 個別に delete/分割代入で除去しており、GET/PUT /me では apiKey の除去が漏れていた
// （= 自分の API キーがレスポンスに露出）。除去ポリシーをここ一箇所に集約することで、
// 将来 2FA 秘密鍵等の機密フィールドを追加した際も全レスポンスに一括反映される。
const SENSITIVE_USER_FIELDS = Object.freeze([
  'password',
  'apiKey',
  // 将来の拡張に備えた防御的列挙（存在しなければ無害）
  'twoFactorSecret',
  'totpSecret',
  'mfaSecret',
  'resetToken',
  'passwordResetToken',
  // セキュリティ監査フィールド: ユーザーに返すと「いつ管理者がセッションを強制失効させたか」
  // 「いつパスワードが変更されたか」を攻撃者が確認できてしまう（侵害後の検知タイミングを把握される）。
  'sessionsRevokedAt',
  'passwordChangedAt',
]);

/**
 * 機密フィールドを除いた浅いコピーを返す。null/非オブジェクトはそのまま返す。
 * @param {object} user
 * @returns {object}
 */
function sanitizeUser(user) {
  if (!user || typeof user !== 'object') return user;
  const safe = { ...user };
  for (const field of SENSITIVE_USER_FIELDS) delete safe[field];
  return safe;
}

module.exports = { sanitizeUser, SENSITIVE_USER_FIELDS };
