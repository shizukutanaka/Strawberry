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
  const now = Math.floor(Date.now() / 1000);
  for (const field of ['passwordChangedAt', 'sessionsRevokedAt']) {
    const ts = user[field];
    if (!ts) continue;
    const cutoff = Math.floor(Date.parse(ts) / 1000);
    // cutoff <= now ガード: 未来タイムスタンプ（時計スキュー・DB 汚染）を無視する。
    // 未来の cutoff は iat <= cutoff を常に真にし、全トークンを永続失効させてしまう。
    if (Number.isFinite(cutoff) && cutoff <= now && iat <= cutoff) return true;
  }
  return false;
}

/**
 * 無効化境界と同じ秒が終わるまで待つ（最大 1 秒）。
 *
 * 上の判定は「境界と同じ秒に発行されたトークン」も拒否する（iat は秒精度なので、
 * 同じ秒の中で変更の前後を区別できない以上、安全側に倒す）。その裏返しとして、
 * パスワード変更の直後に同じ秒内でログインすると、発行したばかりのトークンが
 * 次の要求で「無効なトークン」になる。人が画面で変更→再ログインする速さでも
 * 実際に起きた（E2E で再現）。ログイン側でこれを呼び、境界の秒を跨いでから
 * トークンを発行する。境界が現在秒より前なら何も待たない。
 * @param {object|null} user
 * @returns {Promise<void>}
 */
async function waitPastInvalidationBoundary(user) {
  if (!user) return;
  let latestCutoffMs = 0;
  for (const field of ['passwordChangedAt', 'sessionsRevokedAt']) {
    const ms = user[field] ? Date.parse(user[field]) : NaN;
    if (Number.isFinite(ms) && ms > latestCutoffMs) latestCutoffMs = ms;
  }
  if (!latestCutoffMs) return;
  const cutoffSec = Math.floor(latestCutoffMs / 1000);
  const nowMs = Date.now();
  if (cutoffSec < Math.floor(nowMs / 1000)) return; // もう別の秒
  const waitMs = Math.min(1000, (cutoffSec + 1) * 1000 - nowMs + 5);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
}

module.exports = { isSessionInvalidated, waitPastInvalidationBoundary };
