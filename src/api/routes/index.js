// src/api/routes/index.js - APIルートのエントリポイント
const express = require('express');
const router = express.Router();
const jwtAuth = require('../middleware/jwt-auth');
const rbac = require('../middleware/rbac');
const { logger } = require('../../utils/logger');

// 各ルートモジュールをインポート
const gpuRoutes = require('./gpu');
const orderRoutes = require('./order');
const paymentRoutes = require('./payment');
const userRoutes = require('./user');
const marketplaceRoutes = require('./marketplace');
const authRoutes = require('./auth');

// --- core層の主要サービスは共有のガード付きシングルトンから取得 ---
const { gpuDetector, vgpuManager, p2pNetwork, lightning, requireService } = require('../../core/services');
const { asyncHandler } = require('../../utils/error-handler');
const { cacheMiddleware, purgeCache } = require('../middleware/cache');

// 初期化処理（各ステップを個別にガード。一部のサービスが未導入でも継続し、
// Web API 本体は常に起動できるようにする）
(async () => {
  try {
    logger.info('Initializing core services...');
    let gpus = [];
    if (gpuDetector && typeof gpuDetector.detectAMDGPUsAdvanced === 'function') {
      gpus = await gpuDetector.detectAMDGPUsAdvanced();
      logger.info(`Detected ${gpus.length} GPUs`);
    }
    if (vgpuManager && typeof vgpuManager.initialize === 'function') {
      logger.info('Initializing Virtual GPU Manager...');
      await vgpuManager.initialize(gpus);
    }
    if (p2pNetwork && typeof p2pNetwork.start === 'function') {
      logger.info('Starting P2P Network...');
      await p2pNetwork.start();
    }
    if (lightning && typeof lightning.initialize === 'function') {
      logger.info('Connecting to Lightning Network...');
      await lightning.initialize();
    }
    logger.info('Core services initialization finished');
  } catch (e) {
    logger.error('Failed to initialize core services:', e);
  }
})();

// セキュリティヘッダ(helmet)とCORSは server.js で一元適用する。
// ここで cors({origin:'*'}) を重ねると後勝ちで Access-Control-Allow-Origin が '*' に
// 上書きされ、security.js の corsOrigins 許可リスト設定が無効化されるため適用しない。
// --- レートリミット ---
const rateLimit = require('../middleware/rate-limit');
router.use(rateLimit);
// --- JWT認証を全ルートに適用（公開エンドポイントは除外） ---
// 重要: 認証情報を取得する前にアクセスする必要があるエンドポイント（新規登録・ログイン）は
// 必ず除外する。これらを保護下に置くと「トークンを得るためにトークンが要る」という
// 鶏卵問題でログイン/登録が一切不可能になる（実際にそうなっていた既存バグ）。
const PUBLIC_PATHS = new Set([
  '/system/info',      // 後続で rbac('admin') により保護
  '/users/register',   // 新規登録（公開）
  '/users/login',      // ログイン（公開, トークン発行元）
  '/users/refresh',    // アクセストークン更新（アクセストークン失効時に使うため公開。本体でリフレッシュトークンを検証）
  '/gpus',             // GPU一覧は認証なしで閲覧可能（マーケットプレイスブラウジング）
]);
// /auth/* と /gpus/* は全てトークン不要（GPU 詳細・スケジュール照会も公開閲覧対象）
function isPublicPath(path) {
  return PUBLIC_PATHS.has(path)
    || path.startsWith('/auth/')
    || path.startsWith('/gpus/')
    // プロバイダ公開レピュテーション照会（閲覧はマーケット信頼判断のため公開、GETのみ）
    || /^\/users\/[^/]+\/reputation$/.test(path);
}
router.use((req, res, next) => {
  if (isPublicPath(req.path)) return next();
  jwtAuth(req, res, next);
});
// --- 監査ログ ---
const auditLogger = require('../middleware/audit');
router.use(auditLogger);

// 各ルートモジュールをマウント
router.use('/gpus', gpuRoutes);
router.use('/orders', orderRoutes);
router.use('/payments', paymentRoutes);
router.use('/users', userRoutes);
router.use('/marketplace', marketplaceRoutes);
router.use('/auth', authRoutes);
// 通知設定 CRUD（モジュール内パスが /notification-settings/:userId のためプレフィックスなしでマウント）
router.use(require('../notification-settings').router);

// Lightningノード情報API
router.get('/node-info', cacheMiddleware(), async (req, res) => {
  if (!requireService(lightning, res)) return;
  try {
    const info = await lightning.getNodeInfo();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get node info' });
  }
});

// Lightningチャネル情報API
router.get('/channels', cacheMiddleware(), async (req, res) => {
  if (!requireService(lightning, res)) return;
  try {
    const channels = Array.from(lightning.channels.values());
    res.json(channels);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get channels' });
  }
});

// キャッシュ全体パージAPI（管理者のみ）
router.post('/admin/cache/purge', jwtAuth, rbac('admin'), (req, res) => {
  try {
    purgeCache();
    res.status(200).json({ message: 'Cache purged' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to purge cache' });
  }
});

// マーケットプレイス統計API（管理者のみ）— GMV・注文状況・GPU 稼働の俯瞰
router.get('/admin/stats', jwtAuth, rbac('admin'), asyncHandler(async (req, res) => {
  const UserRepository = require('../../db/json/UserRepository');
  const GpuRepository = require('../../db/json/GpuRepository');
  const OrderRepository = require('../../db/json/OrderRepository');

  const users = UserRepository.getAll();
  const gpus = GpuRepository.getAll();
  const orders = OrderRepository.getAll();

  const usersByRole = {};
  for (const u of users) usersByRole[u.role || 'user'] = (usersByRole[u.role || 'user'] || 0) + 1;

  const ordersByStatus = {};
  let gmvSats = 0;
  let gmvJPY = 0;
  for (const o of orders) {
    ordersByStatus[o.status] = (ordersByStatus[o.status] || 0) + 1;
    if (o.status === 'completed') {
      gmvSats += typeof o.totalPrice === 'number' ? o.totalPrice : 0;
      gmvJPY += typeof o.totalPriceJPY === 'number' ? o.totalPriceJPY : 0;
    }
  }

  const BLOCKING = new Set(['pending', 'matched', 'active']);
  const occupiedGpuIds = new Set(orders.filter(o => BLOCKING.has(o.status)).map(o => o.gpuId));

  res.json({
    timestamp: new Date().toISOString(),
    users: { total: users.length, byRole: usersByRole },
    gpus: {
      total: gpus.length,
      occupied: gpus.filter(g => occupiedGpuIds.has(g.id)).length,
      available: gpus.filter(g => !occupiedGpuIds.has(g.id)).length,
    },
    orders: { total: orders.length, byStatus: ordersByStatus },
    gmv: { completedSats: gmvSats, completedJPY: gmvJPY },
  });
}));

// システム情報取得（adminのみ許可）
router.get('/system/info', jwtAuth, rbac('admin'), asyncHandler(async (req, res) => {
  // システム情報を取得
  const systemInfo = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    cpuUsage: process.cpuUsage()
  };
  
  res.json(systemInfo);
}));

// 後方互換性のための古いエンドポイント（非推奨）
// 将来的に削除予定
// 注: 旧 GET /gpus はここより前に gpuRoutes（router.use('/gpus')）が必ず応答するため
// 到達不能となっており削除済み。
router.post('/order', asyncHandler(async (req, res) => {
  logger.warn('Deprecated endpoint /order accessed, use /api/v1/orders instead');
  if (!requireService(p2pNetwork, res)) return;
  const order = req.body;
  await p2pNetwork.broadcastOrder(order);
  res.status(201).json({ message: 'Order created', order });
}));

router.post('/match', asyncHandler(async (req, res) => {
  logger.warn('Deprecated endpoint /match accessed, use /api/v1/orders/:id/match instead');
  if (!requireService(p2pNetwork, res)) return;
  const matchResult = await p2pNetwork.matchOrder(req.body);
  res.json({ matched: !!matchResult, detail: matchResult });
}));

router.post('/payment', asyncHandler(async (req, res) => {
  logger.warn('Deprecated endpoint /payment accessed, use /api/v1/payments/pay instead');
  if (!requireService(lightning, res)) return;
  const { paymentRequest, amount } = req.body;
  const result = await lightning.payInvoice(paymentRequest, amount);
  res.json({ status: 'paid', result });
}));

// --- 共通エラーハンドリング ---
const { errorMiddleware } = require('../../utils/error-handler');
router.use(errorMiddleware);

module.exports = router;
