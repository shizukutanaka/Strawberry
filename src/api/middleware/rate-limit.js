// src/api/middleware/rate-limit.js - APIレートリミット
const rateLimit = require('express-rate-limit');

const message = {
  error: {
    type: 'RATE_LIMIT',
    message: 'リクエストが多すぎます。しばらく待って再試行してください。',
    statusCode: 429
  }
};

// 全エンドポイント共通: 1分間60リクエスト
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message
});

// 認証エンドポイント専用: 15分間10リクエスト（ブルートフォース対策）
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message
});

module.exports = limiter;
module.exports.authLimiter = authLimiter;
