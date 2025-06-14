// src/api/routes/index.js - APIルートのエントリポイント
const express = require('express');
const router = express.Router();
const jwtAuth = require('../middleware/jwt-auth');
const rbac = require('../middleware/rbac');
const cors = require('cors');
const helmet = require('helmet');
const { logger } = require('../../utils/logger');

// 各ルートモジュールをインポート
const gpuRoutes = require('./gpu');
const orderRoutes = require('./order');
const paymentRoutes = require('./payment');
const userRoutes = require('./user');

// --- core層の主要クラスをインポート ---
const { ExtendedGPUDetector } = require('../../core/gpu-detector-extended');
const { VirtualGPUManager } = require('../../../virtual-gpu-manager');
const { P2PNetwork } = require('../../../p2p-network');
const { LightningService } = require('../../../lightning-service');
const { cacheMiddleware, purgeCache } = require('../middleware/cache');

// シングルトンで1インスタンスずつ生成
const gpuDetector = new ExtendedGPUDetector();
const vgpuManager = new VirtualGPUManager();
const p2pNetwork = new P2PNetwork();
const lightning = new LightningService();

// 初期化処理
(async () => {
  try {
    logger.info('Initializing core services...');
    
    // GPU検出
    logger.info('Detecting GPUs...');
    const gpus = await gpuDetector.detectAMDGPUsAdvanced();
    logger.info(`Detected ${gpus.length} GPUs`);
    
    // 仮想GPU管理システム初期化
    logger.info('Initializing Virtual GPU Manager...');
    await vgpuManager.initialize(gpus);
    
    // P2Pネットワーク起動
    logger.info('Starting P2P Network...');
    await p2pNetwork.start();
    
    // Lightning Network接続
    logger.info('Connecting to Lightning Network...');
    await lightning.initialize();
    
    logger.info('All core services initialized successfully');
  } catch (e) {
    logger.error('Failed to initialize core services:', e);
  }
})();

// --- セキュリティ・CORS ---
router.use(helmet());
router.use(cors({
  origin: '*', // 必要に応じて許可ドメインを限定
}));
// --- レートリミット ---
const rateLimit = require('../middleware/rate-limit');
router.use(rateLimit);
// --- JWT認証を全ルートに適用（/system/info以外） ---
router.use((req, res, next) => {
  if (req.path === '/system/info') return next();
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

// Lightningノード情報API
router.get('/node-info', cacheMiddleware(), async (req, res) => {
  try {
    const info = await lightning.getNodeInfo();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get node info' });
  }
});

// Lightningチャネル情報API
router.get('/channels', cacheMiddleware(), async (req, res) => {
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
router.get('/gpus', asyncHandler(async (req, res) => {
  logger.warn('Deprecated endpoint /gpus accessed, use /api/v1/gpus instead');
  const gpus = vgpuManager.physicalGPUs || [];
  res.json({ gpus });
}));

router.post('/order', asyncHandler(async (req, res) => {
  logger.warn('Deprecated endpoint /order accessed, use /api/v1/orders instead');
  const order = req.body;
  await p2pNetwork.broadcastOrder(order);
  res.status(201).json({ message: 'Order created', order });
}));

router.post('/match', asyncHandler(async (req, res) => {
  logger.warn('Deprecated endpoint /match accessed, use /api/v1/orders/:id/match instead');
  const matchResult = await p2pNetwork.matchOrder(req.body);
  res.json({ matched: !!matchResult, detail: matchResult });
}));

router.post('/payment', asyncHandler(async (req, res) => {
  logger.warn('Deprecated endpoint /payment accessed, use /api/v1/payments/pay instead');
  const { paymentRequest, amount } = req.body;
  const result = await lightning.payInvoice(paymentRequest, amount);
  res.json({ status: 'paid', result });
}));

// --- 共通エラーハンドリング ---
const { errorMiddleware } = require('../../utils/error-handler');
router.use(errorMiddleware);

module.exports = router;
