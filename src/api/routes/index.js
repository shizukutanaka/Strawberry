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
const { gpuDetector, vgpuManager, lightning, requireService } = require('../../core/services');
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
  // '/system/info' を除外: admin 専用エンドポイントを PUBLIC_PATHS に含めると
  // グローバル jwtAuth がスキップされ、ルート内の inline jwtAuth が唯一の防衛線になる。
  // その inline jwtAuth が将来削除された瞬間に完全認証バイパスとなる構造的罠。
  // rbac('admin') が !req.user で 401 を返すため現時点は突破されないが、
  // 「認証不要パス」に admin エンドポイントを置くこと自体が設計上の誤り。
  '/users/register',   // 新規登録（公開）
  '/users/login',      // ログイン（公開, トークン発行元）
  '/users/refresh',    // アクセストークン更新（アクセストークン失効時に使うため公開。本体でリフレッシュトークンを検証）
  '/gpus',             // GPU一覧は認証なしで閲覧可能（マーケットプレイスブラウジング）
]);
// /auth/* と /gpus/* は GET のみトークン不要（マーケット閲覧用途）。
// 旧実装は method を問わず /gpus/ を startsWith で blanket 免除していたため、将来
// /gpus/:id/<新ルート> に POST/PUT/DELETE が追加された際に意図せず認証バイパスとなる
// 危険があった。method ガードで mutation は必ず JWT を要求する形に絞る。
function isPublicPath(path, method) {
  const isGet = method === 'GET' || method === 'HEAD';
  return PUBLIC_PATHS.has(path)
    || path.startsWith('/auth/')
    || (isGet && path.startsWith('/gpus/'))
    // プロバイダ公開レピュテーション照会 & 借り手公開プロフィール（閲覧はマーケット信頼判断のため公開、GETのみ）
    || (isGet && /^\/users\/[^/]+\/reputation$/.test(path))
    || (isGet && /^\/users\/[^/]+\/renter-profile$/.test(path))
    // マーケット公開統計（サプライ・ディマンド・価格帯の概要 — 閲覧のみ）
    || (isGet && path === '/marketplace/stats');
}
router.use((req, res, next) => {
  if (isPublicPath(req.path, req.method)) return next();
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

// Lightningノード情報API（管理者のみ: ノード公開鍵・ピア情報・容量を含む）
// payment/index.js の同等エンドポイントと同じ admin ガードを適用する。
// 認証済み一般ユーザーがチャネル残高・ピア接続情報を閲覧できると
// チャネル枯渇・フィースナイプ等の Lightning 攻撃計画を補助する。
router.get('/node-info', jwtAuth, rbac('admin'), cacheMiddleware(), async (req, res) => {
  if (!requireService(lightning, res)) return;
  try {
    const info = await lightning.getNodeInfo();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get node info' });
  }
});

// Lightningチャネル情報API（管理者のみ）
router.get('/channels', jwtAuth, rbac('admin'), cacheMiddleware(), async (req, res) => {
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

// 検証レコード一覧（管理者のみ）— ジョブ再実行監査の結果を閲覧・デバッグ用
router.get('/admin/verifications', jwtAuth, rbac('admin'), asyncHandler(async (req, res) => {
  const VerificationRepository = require('../../db/json/VerificationRepository');
  const all = VerificationRepository.getAll();
  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  // ?passed=true/false でフィルタ
  let records = all;
  if (req.query.passed === 'true') records = all.filter(v => v.passed === true);
  else if (req.query.passed === 'false') records = all.filter(v => v.passed === false);
  // 最新順
  records = [...records].sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({
    total: records.length,
    limit,
    offset,
    records: records.slice(offset, offset + limit),
  });
}));

// 単一検証レコード取得（管理者のみ）
router.get('/admin/verifications/:jobId', jwtAuth, rbac('admin'), asyncHandler(async (req, res) => {
  const VerificationRepository = require('../../db/json/VerificationRepository');
  const record = VerificationRepository.getByJobId(req.params.jobId);
  if (!record) return res.status(404).json({ error: 'Verification record not found' });
  res.json(record);
}));

// エスクロー一覧（管理者のみ）— orderId・state で絞り込み可能。
// 注文当事者は GET /orders/:id/payment で自分の注文のエスクローを閲覧できるが、
// 管理者が全エスクローをクロス検索する手段がなかった。
router.get('/admin/escrow', jwtAuth, rbac('admin'), asyncHandler(async (req, res) => {
  const EscrowRepository = require('../../db/json/EscrowRepository');
  let escrows = EscrowRepository.getAll();
  if (req.query.orderId) escrows = escrows.filter(e => e.orderId === req.query.orderId);
  if (req.query.state) escrows = escrows.filter(e => e.state === req.query.state);
  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const total = escrows.length;
  const page = escrows.slice(offset, offset + limit);
  res.json({ total, limit, offset, escrows: page });
}));

// 期限切れ注文の手動スイープ（管理者のみ）— インシデント対応・テストで使用。
// POST /admin/expire-orders { types?: ['pending','matched','disputed'] }
router.post('/admin/expire-orders', jwtAuth, rbac('admin'), asyncHandler(async (req, res) => {
  const { expireStaleOrders, expireStaleMatchedOrders, expireStaleDisputedOrders, expireStaleActiveOrders } = require('../../utils/order-expiry');
  const types = Array.isArray(req.body && req.body.types) ? req.body.types : ['pending', 'matched', 'disputed', 'active'];
  const VALID = new Set(['pending', 'matched', 'disputed', 'active']);
  const invalid = types.filter(t => !VALID.has(t));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Invalid types: ${invalid.join(', ')}. Valid: ${[...VALID].join(', ')}` });
  }
  const result = {};
  if (types.includes('pending'))   result.pendingExpired   = expireStaleOrders();
  if (types.includes('matched'))   result.matchedExpired   = expireStaleMatchedOrders();
  if (types.includes('disputed'))  result.disputedResolved = expireStaleDisputedOrders();
  if (types.includes('active'))    result.activeExpired    = expireStaleActiveOrders().length;
  res.json({ message: 'Order expiry sweep completed', ...result });
}));

// システム情報取得（adminのみ許可）
// /system/info は PUBLIC_PATHS から除外されたため、グローバル jwtAuth が先に動作する。
// 冗長な inline jwtAuth は不要。
router.get('/system/info', rbac('admin'), asyncHandler(async (req, res) => {
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

// --- 共通エラーハンドリング ---
const { errorMiddleware } = require('../../utils/error-handler');
router.use(errorMiddleware);

module.exports = router;
