// src/api/middleware/rate-limit.js - APIレートリミット
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1分間
  max: 60, // 1分間に最大60リクエスト
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      type: 'RATE_LIMIT',
      message: 'リクエストが多すぎます。しばらく待って再試行してください。',
      statusCode: 429
    }
  }
});

module.exports = limiter;
