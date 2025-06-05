// src/api/server.js - Express APIサーバー
const express = require('express');
const path = require('path');
const routes = require('./routes');
const { config } = require('../utils/config');
const { logger } = require('../utils/logger');
const { errorMiddleware, notFoundMiddleware } = require('../utils/error-handler');
const { 
  securityHeaders, 
  corsMiddleware, 
  apiLimiter 
} = require('./middleware/security');
const { 
  requestId, 
  requestLogger, 
  devRequestLogger, 
  responseTime, 
  errorLogger 
} = require('./middleware/logger');

// Expressアプリケーション初期化
const app = express();
const PORT = config.server.port || 3000;

// リクエストID生成（ロギング用）
app.use(requestId);

// セキュリティミドルウェア
app.use(securityHeaders);
app.use(corsMiddleware);

// レート制限（DoS対策）
if (config.security.rateLimitEnabled) {
  app.use(apiLimiter);
}

// ボディパーサー
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 静的ファイル
app.use(express.static(path.join(__dirname, '../../public')));

// リクエストロギング
app.use(responseTime);
app.use(requestLogger);

// 開発環境の場合は詳細なリクエストログを出力
if (process.env.NODE_ENV === 'development') {
  app.use(devRequestLogger);
}

// APIルート
app.use(config.server.apiPrefix || '/api/v1', routes);

// フロントエンドルート（SPA対応）
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/index.html'));
});

// 404ハンドラー
app.use(notFoundMiddleware);

// エラーロギング
app.use(errorLogger);

// エラーハンドリング
app.use(errorMiddleware);

// サーバー起動
const server = app.listen(PORT, config.server.host || 'localhost', () => {
  logger.info(`Strawberry API server running on ${config.server.host || 'localhost'}:${PORT}`);
  logger.info(`API prefix: ${config.server.apiPrefix || '/api/v1'}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// グレースフルシャットダウン
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

module.exports = { app, server };
