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
// TRUST_PROXY を hop 数（正の整数: 1, 2, …）として解釈する。
// 'true' / 'yes' 等のブーリアン文字列は意図的に拒否する:
//   Express app.set('trust proxy', true) は全 hop を信頼するため
//   X-Forwarded-For の左端（完全に攻撃者制御）が req.ip になり、
//   送信元 IP を自由に偽装して authLimiter をバイパスできてしまう。
// 整数 hop 数（例: TRUST_PROXY=1）のときのみ req.ip を信頼する。
const rateLimitKeyGenerator = (req) => {
  const hopCount = parseInt(process.env.TRUST_PROXY, 10);
  if (Number.isInteger(hopCount) && hopCount > 0) {
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
