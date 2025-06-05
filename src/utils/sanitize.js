// 入力サニタイズユーティリティ
module.exports = {
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
