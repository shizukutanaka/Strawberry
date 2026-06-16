// src/api/middleware/rate-limit.js - APIレートリミット
const rateLimit = require('express-rate-limit');

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

// X-Forwarded-For ヘッダ偽装によるレート制限回避を防ぐ keyGenerator。
// TRUST_PROXY=1 のとき Express の req.ip（プロキシが付与した実 IP）を使い、
// それ以外はソケットの TCP 接続元アドレスを直接使う（偽装不可）。
const rateLimitKeyGenerator = (req) => {
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy && trustProxy !== '0' && trustProxy !== 'false') {
    return req.ip || req.socket.remoteAddress || 'unknown';
  }
  return req.socket.remoteAddress || req.ip || 'unknown';
};

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
