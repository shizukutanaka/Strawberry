// src/api/middleware/logger.js - リクエストログミドルウェア
const morgan = require('morgan');
const { logger } = require('../../utils/logger');

// カスタムトークン定義
morgan.token('id', (req) => req.id);
morgan.token('user', (req) => (req.user ? req.user.id : 'anonymous'));
morgan.token('body', (req) => {
  // 機密情報をマスク
  const body = { ...req.body };
  
  // パスワードなどの機密情報をマスク
  if (body.password) body.password = '[REDACTED]';
  if (body.token) body.token = '[REDACTED]';
  if (body.paymentRequest) body.paymentRequest = '[REDACTED]';
  
  return JSON.stringify(body);
});

// リクエストIDを生成するミドルウェア
const requestId = (req, res, next) => {
  const uuid = require('uuid');
  req.id = uuid.v4();
  next();
};

// リクエストロガー
const requestLogger = morgan(
  ':id :remote-addr - :user ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" - :response-time ms',
  {
    stream: {
      write: (message) => {
        logger.info(message.trim());
      },
    },
  }
);

// 詳細なリクエストロガー（開発環境用）
const devRequestLogger = morgan(
  ':id :method :url :status :response-time ms - :body',
  {
    stream: {
      write: (message) => {
        logger.debug(message.trim());
      },
    },
  }
);

// レスポンスタイム測定ミドルウェア
const responseTime = (req, res, next) => {
  const start = Date.now();
  
  // レスポンス送信後に実行
  res.on('finish', () => {
    const duration = Date.now() - start;
    
    // 遅いレスポンスを警告
    if (duration > 1000) {
      logger.warn(`Slow response: ${req.method} ${req.originalUrl} - ${duration}ms`);
    }
    
    // メトリクス収集（将来的に拡張）
    // TODO: Prometheusなどのメトリクス収集システムと連携
  });
  
  next();
};

// エラーロガー
const errorLogger = (err, req, res, next) => {
  // エラーの詳細をログに記録
  logger.error(`${err.name || 'Error'}: ${err.message}`, {
    requestId: req.id,
    path: req.originalUrl,
    method: req.method,
    statusCode: err.statusCode || 500,
    stack: err.stack,
    user: req.user ? req.user.id : 'anonymous'
  });
  
  next(err);
};

module.exports = {
  requestId,
  requestLogger,
  devRequestLogger,
  responseTime,
  errorLogger
};
