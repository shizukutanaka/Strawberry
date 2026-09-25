// src/api/server.js - Express APIサーバー
// OpenTelemetry: 他の全 require より先に読み込む必要がある（auto-instrumentation は
// http/express 等を最初に require する前にパッチしないと効かない）。
// OTEL_EXPORTER_OTLP_ENDPOINT 未設定時は完全な no-op（詳細は同ファイル参照）。
require('../telemetry/instrumentation');
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
  permissionsPolicy,
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
const GpuRepository = require('../db/json/GpuRepository');
const OrderRepository = require('../db/json/OrderRepository');
const coreServices = require('../core/services');
const fs = require('fs');
const { rateLimit: readyRateLimit } = require('express-rate-limit');
const invoicePoller = require('../core/invoice-poller');
const { registerProcessGuards } = require('../utils/process-guards');
const { cacheHitCounter, cacheMissCounter } = require('./middleware/cache');
const { setServices, startMonitor, stopMonitor } = require('../core/service-monitor');
const { stopSessionSweep } = require('./routes/order/sessions');

// Prometheusメトリクス
const client = require('prom-client');
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();

// チャネル数・容量のカスタムメトリクス
const channelCountGauge = new client.Gauge({ name: 'lightning_channel_count', help: 'Number of Lightning channels' });
const channelCapacityGauge = new client.Gauge({ name: 'lightning_channel_total_capacity', help: 'Total capacity of Lightning channels (sats)' });

// メトリクス更新関数
async function updateLightningMetrics() {
  const lightning = coreServices.lightning;
  if (lightning && lightning.channels) {
    channelCountGauge.set(lightning.channels.size);
    let totalCapacity = 0;
    for (const ch of lightning.channels.values()) {
      totalCapacity += ch.capacity || 0;
    }
    channelCapacityGauge.set(totalCapacity);
  }
}
// 10秒ごとに更新（unref: テスト等でプロセス終了を妨げないように）
// NODE_ENV==='test' では起動しない。Jest はテストファイルごとにモジュール
// レジストリを分離するため、このファイルを require する各テストが独自の
// setInterval を作るが、実タイマーは同一プロセスのイベントループに残り続ける。
// 135 スイート分積み上がると 10 秒周期の Lightning メトリクス更新が延々と
// 発火し、後続スイートの supertest リクエストが 30 秒のテストタイムアウトを
// 超える（単体実行では PASS するのに全体実行だけ落ちる、の原因）。
// /metrics ハンドラは毎回 updateLightningMetrics() を await するので、
// このタイマーが無くてもテストのメトリクス値は正しい。
const metricsInterval = process.env.NODE_ENV === 'test'
  ? null
  : setInterval(updateLightningMetrics, 10000);
if (metricsInterval && metricsInterval.unref) metricsInterval.unref();

// Expressアプリケーション初期化
const app = express();
const PORT = config.server.port || 3000;

// 新規為替レートAPIルート
app.use('/api/exchange-rate', exchangeRateRouter);

// コアサービス参照のセットと監視起動
try {
  const { lightning, vgpuManager } = coreServices;
  const svcRefs = {};
  if (lightning) svcRefs.LightningService = lightning;
  if (vgpuManager) svcRefs.VirtualGPUManager = vgpuManager;
  if (Object.keys(svcRefs).length > 0) {
    setServices(svcRefs);
    // NODE_ENV==='test' では監視ループを起動しない。metricsInterval と同じ理由で、
    // テストファイルごとに積み上がる 10 秒周期のヘルスチェックがイベントループを
    // 占有する。加えて監視は「不健全」と判定した LightningService/VirtualGPUManager
    // の initialize() を毎周期呼び直すため、Jest 環境の破棄後に require が走り
    // 「You are trying to `import` a file after the Jest environment has been torn
    // down」を撒き散らしていた。監視ロジック自体は tests/service-monitor.e2e.test.js
    // が monitorServices() を直接呼んで検証しているのでカバレッジは落ちない。
    if (process.env.NODE_ENV !== 'test') {
      startMonitor();
    }
  }
} catch (e) {
  logger.warn('Service monitor could not be started:', e);
}

// Lightningインボイス入金確認ループ（15秒間隔でポーリング、Lightning未導入時は無効）
// テスト環境でのタイマー抑止は invoice-poller.start() 側で行う（start() は
// Lightning サービス参照のバインドも兼ねており、ここで呼び出しごとスキップすると
// pollOnce() を直接叩くテストが「poller not started」で動かなくなるため）。
try {
  const { lightning: lightningForPoller } = coreServices;
  invoicePoller.start(lightningForPoller);
} catch (e) {
  logger.warn(`invoice-poller: failed to start: ${e.message}`);
}

// /metricsエンドポイント（Prometheus スクレイプ用）。
// Lightning チャネル容量・支払い失敗数などの運用データを含むため認証必須。
// METRICS_AUTH_TOKEN が設定されている場合は Bearer <token> で照合する。
// 未設定かつ本番環境では 503 を返す（fail-closed）。テスト環境では素通り。
app.get('/metrics', apiLimiter, (req, res, next) => {
  const metricsToken = process.env.METRICS_AUTH_TOKEN;
  if (!metricsToken) {
    // コメントに「本番では必ず設定すること」と書いても見落とされる。
    // 設定なしで本番稼働したら即座に運用KPIが公開されるため fail-closed にする。
    if (process.env.NODE_ENV !== 'test') {
      return res.status(503).end('Metrics endpoint requires METRICS_AUTH_TOKEN');
    }
    return next();
  }
  const authHeader = req.headers.authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!provided || provided !== metricsToken) {
    return res.status(401).set('WWW-Authenticate', 'Bearer realm="metrics"').end('Unauthorized');
  }
  next();
}, async (req, res) => {
  await updateLightningMetrics();
  // cacheHitCounter, cacheMissCounter はprom-clientに自動登録されている
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
// 同期 I/O を含むため専用レート制限を設ける（グローバル apiLimiter より前にマウントされるが
// このエンドポイント単体には 30 req/min のガードを掛ける）。
const readyLimiter = readyRateLimit({
  windowMs: 60 * 1000,
  max: () => process.env.NODE_ENV === 'test' ? 10000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.get('/ready', readyLimiter, (req, res) => {
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
    GpuRepository.getAll();
    OrderRepository.getAll();
    checks.repositoriesReadable = 'ok';
  } catch (e) {
    ready = false;
    checks.repositoriesReadable = `failed: ${e.message}`;
  }

  // オプショナルサービス（情報のみ。readiness をブロックしない）
  let optional = {};
  try {
    const { lightning } = coreServices;
    optional = { lightning: lightning ? 'available' : 'disabled' };
  } catch (_) { /* services 未解決時は省略 */ }

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
    optionalServices: optional,
    timestamp: new Date().toISOString(),
  });
});

// リクエストID生成（ロギング用）
app.use(requestId);

// 動的APIレスポンスへの Cache-Control: no-store 付与。
// Express は既定で ETag を自動生成するが、Cache-Control を明示しない限り
// 認証必須の動的レスポンス（例: GET /orders/:id の status）がブラウザの
// HTTP キャッシュから再利用されうる。実際に発見された事象: 注文が pending の
// 時点で一度 GET /orders/:id を叩いた後、accept→pay→approve→start を経て
// active になっても、同一URLへの再フェッチが（サーバに到達せず）キャッシュ
// された pending 時点のレスポンスをそのまま返し、UI が古い状態を表示し続けた。
// public/ 配下の静的アセット（JS/CSS）は意図的なキャッシュ対象のため対象外にする。
app.use((req, res, next) => {
  if (!req.path.startsWith('/js/') && !req.path.startsWith('/css/')
    && req.path !== '/' && !req.path.endsWith('.html') && !req.path.endsWith('.ico')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// セキュリティミドルウェア
app.use(securityHeaders);
app.use(permissionsPolicy);
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

// フロントエンドルート（SPA対応）。
// 拡張子付きパス（/js/foo.js, /css/foo.css 等）はアセット欠落・タイポを意味する —
// index.html (200, text/html) にフォールバックすると「JSファイルなのにHTMLが
// 返る」という分かりにくい実行時エラーになりデバッグを妨げるため、素直に404にする。
// 拡張子なしのパス（SPAのハッシュルート等）のみ index.html にフォールバックする。
app.get('*', (req, res, next) => {
  if (path.extname(req.path)) return next();
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

  // keep-alive タイムアウトを上流プロキシのアイドル切断（ALB/nginx の既定 60s）より
  // 長くする。Node 既定は keepAliveTimeout=5s・headersTimeout=60s で、プロキシが
  // 再利用しようとしたコネクションをサーバーが先に閉じてしまい、間欠的な 502 を
  // 引き起こす。headersTimeout は keepAliveTimeout より常に大きく保つこと
  // （headersTimeout <= keepAliveTimeout は Node が警告する誤設定）。
  server.keepAliveTimeout = 61_000;
  server.headersTimeout = 65_000;

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
    // ドレイン中にバックグラウンド処理が発火しないよう、先に止めてから
    // HTTP 接続の終了を待つ（各 stop の失敗はシャットダウンを妨げない）。
    try { invoicePoller.stop(); } catch (_) {}
    try { stopMonitor(); } catch (_) {}
    try { stopSessionSweep(); } catch (_) {}
    if (metricsInterval) clearInterval(metricsInterval);
    server.close(() => {
      clearTimeout(forceExit);
      const lnShutdown = coreServices.lightning && typeof coreServices.lightning.shutdown === 'function'
        ? coreServices.lightning.shutdown()
        : null;
      Promise.resolve(lnShutdown)
        .catch((err) => logger.error('Error during Lightning shutdown', { error: err.message }))
        .finally(() => {
          logger.info('HTTP server closed');
          process.exit(0);
        });
    });
  };
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // プロセスレベルの最終防衛ライン（未処理例外/リジェクションのログ記録＋安全終了）。
  // main 実行時のみ登録し、テスト（require 経由）では登録しない（テストランナーを落とさない）。
  registerProcessGuards({ logger, getServer: () => server });
}

module.exports = { app, server };
