// 定数時間の秘密値比較ヘルパー。
// `===`/`!==` や生の文字列比較は、応答時間が一致している先頭部分の長さに依存するため
// タイミングオラクルになる。先に長さを見て早期 return する形も、応答時間から秘密値の
// 「長さ」そのものを推測させる。このためランダム nonce 付き HMAC-SHA256 で両入力を
// 固定長(32B)ダイジェストへ正規化してから timingSafeEqual で比較する:
//   (1) 生値の長さ・内容がタイミングに漏れない
//   (2) 長さ不一致でも timingSafeEqual が throw しない
// nonce は比較のたびに新規生成し、ダイジェスト値そのものの再利用も防ぐ。
// master-auth.js の timingSafeStrEqual と同一の Double-HMAC パターン
// （probe70 が master-auth.js のソースを固定するため共通化はここで止める）。
const { createHmac, randomBytes, timingSafeEqual } = require('crypto');

/**
 * 秘密値（APIキー・メトリクス認証トークン等）を定数時間で比較する。
 * null/undefined は空文字として扱い false を返す（期待値が空なら常に false）。
 * @param {*} provided リクエスト側で提示された値
 * @param {*} expected 期待する秘密値
 * @returns {boolean}
 */
function safeTokenEqual(provided, expected) {
  const a = provided == null ? '' : String(provided);
  const b = expected == null ? '' : String(expected);
  // 空文字どうしの一致で成功扱いにならないよう除外（期待値未設定の誤認証を防ぐ）
  if (a === '' || b === '') return false;
  const nonce = randomBytes(32);
  const aHash = createHmac('sha256', nonce).update(a).digest();
  const bHash = createHmac('sha256', nonce).update(b).digest();
  return timingSafeEqual(aHash, bHash);
}

module.exports = { safeTokenEqual };
