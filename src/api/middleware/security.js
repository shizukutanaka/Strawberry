// src/api/middleware/security.js - セキュリティ関連ミドルウェア
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { config } = require('../../utils/config');
const { APIError, ErrorTypes } = require('../../utils/error-handler');
// シークレット解決は jwt-auth.js と共有する（process.env.JWT_SECRET 優先）。
// 別々に解決すると鍵ローテーション時にグローバルゲートと本ミドルウェアで
// 受理可否が食い違う（片方だけ旧鍵で検証する）ため必ず一元化すること。
const { resolveSecret } = require('./jwt-auth');

// HSTSやXSS対策などのセキュリティヘッダー設定
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'wss://*'],
    },
  },
  xssFilter: true,
  noSniff: true,
  referrerPolicy: { policy: 'same-origin' },
});

// CORS設定
// 重要: CORS 仕様上、origin が '*'（ワイルドカード）のとき credentials:true は不正で、
// ブラウザはレスポンスを拒否する（Cookie/Authorization を伴うリクエストが全滅）。
// ワイルドカード時は credentials を無効化し、特定オリジン許可時のみ credentials を有効にする。
const corsWildcard = config.server.corsOrigins === '*';
const corsOptions = {
  origin: corsWildcard ? '*' : config.server.corsOrigins.split(','),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: !corsWildcard,
  maxAge: 86400, // 24時間
};

// X-Forwarded-For 偽装によるレート制限回避を防ぐ keyGenerator（rate-limit.js と同じポリシー）
const _rlKeyGenerator = (req) => {
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy && trustProxy !== '0' && trustProxy !== 'false') {
    return req.ip || req.socket.remoteAddress || 'unknown';
  }
  return req.socket.remoteAddress || req.ip || 'unknown';
};

// レート制限設定
const apiLimiter = rateLimit({
  windowMs: config.server.rateLimitWindowMs,
  max: () => process.env.NODE_ENV === 'test' ? 10000 : config.server.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: _rlKeyGenerator,
  message: {
    error: {
      type: ErrorTypes.FORBIDDEN,
      message: 'Too many requests, please try again later',
      statusCode: 429,
    },
  },
});

// JWTトークン検証ミドルウェア
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return next(new APIError(
      ErrorTypes.UNAUTHORIZED,
      'Authentication required',
      401
    ));
  }
  
  const tokenParts = authHeader.split(' ');
  
  if (tokenParts.length !== 2 || tokenParts[0] !== 'Bearer') {
    return next(new APIError(
      ErrorTypes.UNAUTHORIZED,
      'Invalid token format',
      401
    ));
  }
  
  const token = tokenParts[1];
  
  try {
    // algorithms を固定し、アルゴリズム混同攻撃（alg=none / RS256 すり替え）を防ぐ。
    // 署名は HS256（文字列シークレットの jwt.sign 既定）で行っている。
    const decoded = jwt.verify(token, resolveSecret(), { algorithms: ['HS256'] });
    // リフレッシュトークンをアクセストークンとして使わせない（jwt-auth.js と同一ポリシー）
    if (decoded.type === 'refresh') {
      return next(new APIError(ErrorTypes.UNAUTHORIZED, 'Invalid token', 401));
    }
    // logout で失効済みのトークン(jti)を拒否（jwt-auth.js と同一ポリシー）
    const { isRevoked } = require('./token-denylist');
    if (decoded.jti && isRevoked(decoded.jti)) {
      return next(new APIError(ErrorTypes.UNAUTHORIZED, 'Invalid token', 401));
    }
    // パスワード変更・アカウント無効化後のトークンを拒否。
    // 攻撃者が盗んだトークンを保持していても、被害者がパスワードを変更した時点で
    // 全セッションが無効化される（jti 単体失効では対応できない他端末トークンも含む）。
    const UserRepository = require('../../db/json/UserRepository');
    const tokenUser = UserRepository.getById(decoded.id);
    if (!tokenUser || tokenUser.status === 'deactivated') {
      return next(new APIError(ErrorTypes.UNAUTHORIZED, 'Invalid token', 401));
    }
    const { isSessionInvalidated } = require('../utils/session-invalidation');
    if (isSessionInvalidated(tokenUser, decoded.iat)) {
      return next(new APIError(ErrorTypes.UNAUTHORIZED, 'Invalid token', 401));
    }
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return next(new APIError(
        ErrorTypes.UNAUTHORIZED,
        'Token expired',
        401
      ));
    }
    
    return next(new APIError(
      ErrorTypes.UNAUTHORIZED,
      'Invalid token',
      401
    ));
  }
};

// ロールベースアクセス制御ミドルウェア
const checkRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new APIError(
        ErrorTypes.UNAUTHORIZED,
        'Authentication required',
        401
      ));
    }
    
    if (!roles.includes(req.user.role)) {
      return next(new APIError(
        ErrorTypes.FORBIDDEN,
        'Insufficient permissions',
        403
      ));
    }
    
    next();
  };
};

// APIキー認証ミドルウェア（マシン間通信用）
const authenticateAPIKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return next(new APIError(
      ErrorTypes.UNAUTHORIZED,
      'API key required',
      401
    ));
  }
  
  // API_KEY 環境変数が設定され、かつ一致する場合のみ許可。
  // ハードコードされた 'dev-api-key' バックドアは廃止。
  const validApiKey = process.env.API_KEY;
  // HMAC で固定長ダイジェストに正規化してから timingSafeEqual で比較する。
  // 長さチェックを先行させると長さが違う時点でショートサーキットし、
  // キー長を推測できるタイミングオラクルになるため、この方式で排除する。
  const { createHmac, randomBytes, timingSafeEqual } = require('crypto');
  if (validApiKey) {
    const nonce = randomBytes(32);
    const aHash = createHmac('sha256', nonce).update(apiKey).digest();
    const bHash = createHmac('sha256', nonce).update(validApiKey).digest();
    if (timingSafeEqual(aHash, bHash)) {
      req.apiClient = { id: 'system', name: 'API Client', role: 'system' };
      return next();
    }
  }

  return next(new APIError(
    ErrorTypes.UNAUTHORIZED,
    'Invalid API key',
    401
  ));
};

// 任意のAPIキー検証ミドルウェア（machine間通信用の補助認証）。
// x-api-key ヘッダが無ければ後続の認証(JWT等)に委ねる(continue)。
// 提供された場合のみ検証し、不正なら 401。ハードコードされたキーは持たない。
const { createHmac: _createHmac, randomBytes: _randomBytes, timingSafeEqual: _timingSafeEqual } = require('crypto');
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return next();
  const validApiKey = process.env.API_KEY;
  if (validApiKey) {
    const nonce = _randomBytes(32);
    const aHash = _createHmac('sha256', nonce).update(apiKey).digest();
    const bHash = _createHmac('sha256', nonce).update(validApiKey).digest();
    if (_timingSafeEqual(aHash, bHash)) {
      req.apiClient = { id: 'system', name: 'API Client', role: 'system' };
      return next();
    }
  }
  return next(new APIError(ErrorTypes.UNAUTHORIZED, 'Invalid API key', 401));
};

// リソース所有者または管理者のみ許可
const allowOwnerOrAdmin = (getResource) => async (req, res, next) => {
  try {
    const resource = await getResource(req);
    if (!resource) {
      return next(new APIError(
        ErrorTypes.NOT_FOUND,
        'Resource not found',
        404
      ));
    }
    if (req.user.role === 'admin' || resource.providerId === req.user.id || resource.userId === req.user.id) {
      req.resource = resource;
      return next();
    }
    return next(new APIError(
      ErrorTypes.FORBIDDEN,
      'You do not have permission to access this resource',
      403
    ));
  } catch (e) {
    return next(e);
  }
};

module.exports = {
  securityHeaders,
  corsMiddleware: cors(corsOptions),
  apiLimiter,
  authenticateJWT,
  checkRole,
  apiKeyAuth,
  authenticateAPIKey,
  allowOwnerOrAdmin
};
