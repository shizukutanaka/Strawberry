// 入力サニタイズユーティリティ

/**
 * 機密情報自動マスキング
 * @param {object} obj - マスキング対象オブジェクト
 * @param {string[]} fields - マスキング対象フィールド名（デフォルトは主要機密）
 * @returns {object}
 */
function sanitizeSensitiveFields(obj, fields = [
  'password','secret','token','apiKey','privateKey','email','refreshToken','accessToken','jwt','macaroon','mnemonic','seed'
]) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  // 大文字小文字を問わずマスキング（'Password', 'TOKEN' 等の非標準ケーシングを取り漏らさないため）
  const fieldsLower = fields.map(f => f.toLowerCase());
  for (const k of Object.keys(out)) {
    if (fieldsLower.includes(k.toLowerCase())) out[k] = '[MASKED]';
  }
  // ネストも再帰的にマスキング
  for (const k in out) {
    if (typeof out[k] === 'object' && out[k] !== null) {
      out[k] = sanitizeSensitiveFields(out[k], fields);
    }
  }
  return out;
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
