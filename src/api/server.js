// src/api/server.js - Express APIサーバー
const express = require('express');
const path = require('path');
const routes = require('./routes');
const masterAuthRouter = require('./routes/master-auth');
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
// 10秒ごとに更新（unref: テスト等でプロセス終了を妨げないように）
const metricsInterval = setInterval(updateLightningMetrics, 10000);
if (metricsInterval.unref) metricsInterval.unref();

// Expressアプリケーション初期化
const app = express();
const PORT = config.server.port || 3000;

// キャッシュメトリクス統合
const { cacheHitCounter, cacheMissCounter, cachePurgeCounter } = require('./middleware/cache');
// サービス死活監視モジュール（setServices/startMonitor を使用前に require する: TDZ回避）
const { setServices, startMonitor, serviceRestartCounter, serviceDownCounter } = require('../core/service-monitor');

// 新規為替レートAPIルート
app.use('/api/exchange-rate', exchangeRateRouter);

// コアサービス参照のセットと監視起動
try {
  const { lightning, p2pNetwork, vgpuManager } = require('../core/services');
  const svcRefs = {};
  if (lightning) svcRefs.LightningService = lightning;
  if (p2pNetwork) svcRefs.P2PNetwork = p2pNetwork;
  if (vgpuManager) svcRefs.VirtualGPUManager = vgpuManager;
  if (Object.keys(svcRefs).length > 0) {
    setServices(svcRefs);
    startMonitor();
  }
} catch (e) {
  logger.warn('Service monitor could not be started:', e);
}

// Lightningインボイス入金確認ループ（15秒間隔でポーリング、Lightning未導入時は無効）
try {
  const invoicePoller = require('../core/invoice-poller');
  const { lightning: lightningForPoller } = require('../core/services');
  invoicePoller.start(lightningForPoller);
} catch (e) {
  logger.warn(`invoice-poller: failed to start: ${e.message}`);
}

// /metricsエンドポイント（Prometheus スクレイプ用）。
// Lightning チャネル容量・支払い失敗数などの運用データを含むため認証必須。
// METRICS_AUTH_TOKEN が設定されている場合は Bearer <token> で照合する。
// 未設定時は開発環境として無制限アクセスを許可（本番では必ず設定すること）。
app.get('/metrics', apiLimiter, (req, res, next) => {
  const metricsToken = process.env.METRICS_AUTH_TOKEN;
  if (metricsToken) {
    const authHeader = req.headers.authorization || '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!provided || provided !== metricsToken) {
      return res.status(401).set('WWW-Authenticate', 'Bearer realm="metrics"').end('Unauthorized');
    }
  }
  next();
}, async (req, res) => {
  await updateLightningMetrics();
  // cacheHitCounter, cacheMissCounter, cachePurgeCounterはprom-clientに自動登録されている
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// /health — 死活監視エンドポイント（LB/k8s probe・sla-tracker が参照）。
// レート制限より前に定義し、高頻度ポーリングでも 429 にならないようにする。
const serverStartedAt = Date.now();
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

// /ready — レディネスプローブ（/health の静的 ok と異なり、データ層が実際に使えるかを検証する）。
// JSON データ層が本プロダクトの唯一必須の依存。data ディレクトリへ実際に temp ファイルを書き
// 削除し、リポジトリ読込が例外を投げないことを確認する。失敗時は 503 を返し、LB/k8s が
// トラフィックを流さないようにする。オプショナルサービス（Lightning/P2P）は情報として
// 併記するが readiness のゲートには含めない（未導入でも API 本体は機能するため）。
app.get('/ready', (req, res) => {
  const fs = require('fs');
  const checks = {};
  let ready = true;

  // 1) data ディレクトリの書き込み可否（atomicWriteJSON と同じ依存）
  try {
    const dataDir = path.join(__dirname, '../../data');
    const probe = path.join(dataDir, `.ready-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    checks.dataDirWritable = 'ok';
  } catch (e) {
    ready = false;
    checks.dataDirWritable = `failed: ${e.message}`;
  }

  // 2) リポジトリ読込が例外を投げないこと（破損 JSON 等の早期検知）
  try {
    require('../db/json/GpuRepository').getAll();
    require('../db/json/OrderRepository').getAll();
    checks.repositoriesReadable = 'ok';
  } catch (e) {
    ready = false;
    checks.repositoriesReadable = `failed: ${e.message}`;
  }

  // オプショナルサービス（情報のみ。readiness をブロックしない）
  let optional = {};
  try {
    const { lightning, p2pNetwork } = require('../core/services');
    optional = { lightning: lightning ? 'available' : 'disabled', p2pNetwork: p2pNetwork ? 'available' : 'disabled' };
  } catch (_) { /* services 未解決時は省略 */ }

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
    optionalServices: optional,
    timestamp: new Date().toISOString(),
  });
});

// /openapi.json — API 仕様の HTTP 公開（初回アクセス時に生成しキャッシュ）
let openapiSpecCache = null;
app.get('/openapi.json', apiLimiter, (req, res) => {
  if (!openapiSpecCache) {
    try {
      const { generateOpenAPISpec } = require('./openapi-generator');
      openapiSpecCache = generateOpenAPISpec();
    } catch (e) {
      logger.error('OpenAPI spec generation failed:', e);
      return res.status(500).json({ error: 'Failed to generate OpenAPI spec' });
    }
  }
  res.json(openapiSpecCache);
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
app.use('/master-auth', masterAuthRouter.router);

// 運営利益受取アドレス管理（admin 認証必須。ルータ側で jwtAuth + rbac('admin') を適用）
app.use('/api/profit-addresses', profitAddressesRouter);

// リクエストロギング
app.use(responseTime);
app.use(requestLogger);

// 開発環境の場合は詳細なリクエストログを出力
if (process.env.NODE_ENV === 'development') {
  app.use(devRequestLogger);
}

// APIルート
app.use(config.server.apiPrefix || '/api/v1', routes);

// GraphQL エンドポイント（/graphql）。Apollo の start() は非同期だが、SPA キャッチオール
// より前に必ず配置する必要があるため、サブアプリを同期的にここへ mount してスロットを予約し、
// Apollo は非同期でそのサブアプリへ後付けする。失敗してもサーバ本体は起動を継続（guard）。
const graphqlApp = express();
app.use(graphqlApp);
const graphqlReady = (async () => {
  try {
    const { setupGraphQL } = require('./graphql');
    await setupGraphQL(graphqlApp);
    logger.info('GraphQL endpoint mounted at /graphql');
    return true;
  } catch (e) {
    logger.warn(`GraphQL endpoint disabled: ${e.message}`);
    return false;
  }
})();

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

// サーバー起動（このファイルを直接実行した場合のみ listen する。
// テストから require された場合は listen せず、supertest が app を直接利用する。
// これにより Jest の並列ワーカーでの EADDRINUSE やオープンハンドルを防ぐ）
let server = null;
if (require.main === module) {
  server = app.listen(PORT, config.server.host || 'localhost', () => {
    logger.info(`Strawberry API server running on ${config.server.host || 'localhost'}:${PORT}`);
    logger.info(`API prefix: ${config.server.apiPrefix || '/api/v1'}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // グレースフルシャットダウン（30秒でタイムアウト — ハングしたハンドラで無限待機しない）。
  // SIGTERM(オーケストレータ)と SIGINT(Ctrl-C/開発・一部環境) の両方を扱う。未処理シグナルでの
  // ハード終了は進行中レスポンス・ファイル書込みを切断するため。二重受信に備え冪等化する。
  let shuttingDown = false;
  const gracefulShutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} signal received: closing HTTP server`);
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out after 30s; forcing exit');
      process.exit(1);
    }, 30000);
    if (forceExit.unref) forceExit.unref();
    server.close(() => {
      clearTimeout(forceExit);
      logger.info('HTTP server closed');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = { app, server, graphqlReady };
