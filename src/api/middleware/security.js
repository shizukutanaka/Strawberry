// src/api/middleware/security.js - セキュリティ関連ミドルウェア
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { config } = require('../../utils/config');
const { APIError, ErrorTypes } = require('../../utils/error-handler');

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
const corsOptions = {
  origin: config.server.corsOrigins === '*' 
    ? '*' 
    : config.server.corsOrigins.split(','),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400, // 24時間
};

// レート制限設定
const apiLimiter = rateLimit({
  windowMs: config.server.rateLimitWindowMs,
  max: config.server.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
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
    const decoded = jwt.verify(token, config.security.jwtSecret);
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
  
  // TODO: APIキーの検証ロジックを実装
  // 現在は開発用に簡易的に実装
  if (apiKey === process.env.API_KEY || apiKey === 'dev-api-key') {
    req.apiClient = {
      id: 'system',
      name: 'API Client',
      role: 'system'
    };
    return next();
  }
  
  return next(new APIError(
    ErrorTypes.UNAUTHORIZED,
    'Invalid API key',
    401
  ));
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
