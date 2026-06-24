// src/api/middleware/rate-limit.js - APIレートリミット
const rateLimit = require('express-rate-limit');
// XFF 偽装耐性 + IPv6 /64 畳み込みの keyGenerator は ip-key.js に集約（security.js と共有）。
const { normalizeIpKey, rateLimitKeyGenerator } = require('./ip-key');

const message = {
  error: {
    type: 'RATE_LIMIT',
    message: 'リクエストが多すぎます。しばらく待って再試行してください。',
    statusCode: 429
  }
};

// テスト時は緩和（統合テストが多数の register/login を行うため）。
// max は関数を渡すとリクエスト毎に評価され、env での動的変更が可能。
const isTest = () => process.env.NODE_ENV === 'test';

// 全エンドポイント共通: 1分間60リクエスト
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: () => (isTest() ? 10000 : Number(process.env.RATE_LIMIT_MAX) || 60),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
  message
});

// 認証エンドポイント専用: 15分間10リクエスト（ブルートフォース対策）
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => (isTest() ? 10000 : Number(process.env.AUTH_RATE_LIMIT_MAX) || 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
  message
});

module.exports = limiter;
module.exports.authLimiter = authLimiter;
// テスト用フック（IPv6 /64 正規化と keyGenerator を直接検証する。ip-key.js から再エクスポート）
module.exports._normalizeIpKey = normalizeIpKey;
module.exports._rateLimitKeyGenerator = rateLimitKeyGenerator;
