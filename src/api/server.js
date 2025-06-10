// src/api/server.js - Express APIサーバー
const express = require('express');
const path = require('path');
const routes = require('./routes');
const masterAuthRouter = require('./routes/master-auth');
const paymentRouter = require('./routes/payment');
const profitAddressesRouter = require('./routes/profit-addresses');
const exchangeRateRouter = require('./routes/exchange-rate');
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

// Prometheusメトリクス
const client = require('prom-client');
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();

// LightningServiceからメトリクスを取得するための参照（必要に応じて適切なimportに修正）
let lightningService;
try {
  lightningService = require('../../lightning-service');
} catch (e) {
  // LightningServiceが存在しない場合はスキップ
}

// チャネル数・容量・失敗数などのカスタムメトリクス
const channelCountGauge = new client.Gauge({ name: 'lightning_channel_count', help: 'Number of Lightning channels' });
const channelCapacityGauge = new client.Gauge({ name: 'lightning_channel_total_capacity', help: 'Total capacity of Lightning channels (sats)' });
const paymentFailureCounter = new client.Counter({ name: 'lightning_payment_failure_total', help: 'Total number of payment failures' });
const reconnectCounter = new client.Counter({ name: 'lightning_reconnect_total', help: 'Total number of Lightning gRPC reconnects' });

// メトリクス更新関数
async function updateLightningMetrics() {
  if (lightningService && lightningService.channels) {
    channelCountGauge.set(lightningService.channels.size);
    let totalCapacity = 0;
    for (const ch of lightningService.channels.values()) {
      totalCapacity += ch.capacity || 0;
    }
    channelCapacityGauge.set(totalCapacity);
  }
  // 支払い失敗数・再接続回数はLightningService側からインクリメント呼び出しを想定
}
setInterval(updateLightningMetrics, 10000); // 10秒ごとに更新

// Expressアプリケーション初期化
const app = express();
const PORT = config.server.port || 3000;

// 新規為替レートAPIルート
app.use('/api/exchange-rate', exchangeRateRouter);

// コアサービス参照のセットと監視起動
try {
  // 既存のコアサービス参照を取得
  const routes = require('./routes');
  const lightning = routes.lightning || (routes.default && routes.default.lightning);
  const p2pNetwork = routes.p2pNetwork || (routes.default && routes.default.p2pNetwork);
  const vgpuManager = routes.vgpuManager || (routes.default && routes.default.vgpuManager);
  setServices({ LightningService: lightning, P2PNetwork: p2pNetwork, VirtualGPUManager: vgpuManager });
  startMonitor();
} catch (e) {
  logger.warn('Service monitor could not be started:', e);
}

// キャッシュメトリクス統合
const { cacheHitCounter, cacheMissCounter, cachePurgeCounter } = require('./middleware/cache');
// サービス死活監視モジュール
const { setServices, startMonitor, serviceRestartCounter, serviceDownCounter } = require('../core/service-monitor');

// /metricsエンドポイント
app.get('/metrics', async (req, res) => {
  await updateLightningMetrics();
  // cacheHitCounter, cacheMissCounter, cachePurgeCounterはprom-clientに自動登録されている
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

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

// マスター認証ルート（/master-auth）
app.use('/master-auth', masterAuth.router);

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
