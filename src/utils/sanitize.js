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
  for (const key of fields) {
    if (key in out) out[key] = '[MASKED]';
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
    // 前後空白除去・制御文字・HTMLタグ除去
    return str
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // 制御文字除去
      .replace(/<[^>]*>/g, '') // HTMLタグ除去
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
