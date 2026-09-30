// 入力サニタイズユーティリティ

// 再帰の深度上限。audit.js が req.body を全リクエストでマスクするため、
// 深いネスト JSON（~8,000 段 ≈ 48KB で body-parser の 100KB 上限内）を投げると
// 旧実装は無限再帰で `Maximum call stack size exceeded` → uncaughtException →
// プロセス終了となる DoS が成立していた。32 段を超える部分は '[TRUNCATED]' に置き換える。
const MAX_SANITIZE_DEPTH = 32;

/**
 * 機密情報自動マスキング
 * @param {object} obj - マスキング対象オブジェクト
 * @param {string[]} fields - マスキング対象フィールド名（デフォルトは主要機密）
 * @returns {object}
 */
function sanitizeSensitiveFields(obj, fields = [
  'password','secret','token','apiKey','privateKey','email','refreshToken','accessToken','jwt','macaroon','mnemonic','seed'
]) {
  const fieldsLower = fields.map(f => f.toLowerCase());
  const seen = new WeakSet(); // 循環参照ガード（JSON 由来では起きないが、logger 経由の内部オブジェクトでは起き得る）
  function walk(node, depth) {
    if (!node || typeof node !== 'object') return node;
    if (depth > MAX_SANITIZE_DEPTH) return '[TRUNCATED]';
    if (seen.has(node)) return '[CIRCULAR]';
    seen.add(node);
    // 配列・Date 等も安全側に各要素/値を走査する
    const out = Array.isArray(node) ? [] : { ...node };
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (fieldsLower.includes(k.toLowerCase())) {
        out[k] = '[MASKED]';
      } else if (v !== null && typeof v === 'object') {
        out[k] = walk(v, depth + 1);
      } else {
        out[k] = v;
      }
    }
    seen.delete(node); // 兄弟ブランチでの再出現は循環ではないので解除
    return out;
  }
  return walk(obj, 0);
}

module.exports = {
  sanitizeSensitiveFields,
  sanitizeString(str) {
    if (typeof str !== 'string') return '';
    // 制御文字・HTMLタグ除去。タグ除去後に残る `<`/`>` (例: `<<script>` の外側の `<`) を
    // 不活性化して <<tag> バイパスを閉じる。
    return str
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '') // 制御文字除去
      .replace(/<[^>]*>/g, '') // HTMLタグ除去（1パス）
      .replace(/[<>]/g, '') // 残留角括弧を除去（<<tag> バイパス対策）
      .trim();
  },
  sanitizeObject(obj, keys) {
    if (!obj || typeof obj !== 'object') return {};
    const out = { ...obj };
    for (const key of keys) {
      if (typeof out[key] === 'string') {
        out[key] = module.exports.sanitizeString(out[key]);
      }
    }
    return out;
  }
};
