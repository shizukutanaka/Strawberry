// src/api/routes/index.js - APIルートのエントリポイント
const express = require('express');
const router = express.Router();
const jwtAuth = require('../middleware/jwt-auth');
const { logger } = require('../../utils/logger');

// 各ルートモジュールをインポート
const gpuRoutes = require('./gpu');
const orderRoutes = require('./order');
const paymentRoutes = require('./payment');
const userRoutes = require('./user');
const marketplaceRoutes = require('./marketplace');
const adminRoutes = require('./admin');
const notificationSettings = require('../notification-settings');

// --- core層の主要サービスは共有のガード付きシングルトンから取得 ---
const { gpuDetector, vgpuManager, lightning } = require('../../core/services');
const { errorMiddleware } = require('../../utils/error-handler');
const rateLimit = require('../middleware/rate-limit');
const auditLogger = require('../middleware/audit');

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
// /gpus/* は GET のみトークン不要（マーケット閲覧用途）。
// method ガードで mutation は必ず JWT を要求する。
function isPublicPath(path, method) {
  const isGet = method === 'GET' || method === 'HEAD';
  return PUBLIC_PATHS.has(path)
    || (isGet && path.startsWith('/gpus/'))
    // マーケット公開統計（サプライ・ディマンド・価格帯の概要 — 閲覧のみ）
    || (isGet && path === '/marketplace/stats');
}
router.use((req, res, next) => {
  if (isPublicPath(req.path, req.method)) return next();
  jwtAuth(req, res, next);
});
// --- 監査ログ ---
router.use(auditLogger);

// 各ルートモジュールをマウント
router.use('/gpus', gpuRoutes);
router.use('/orders', orderRoutes);
router.use('/payments', paymentRoutes);
router.use('/users', userRoutes);
router.use('/marketplace', marketplaceRoutes);
// 通知設定 CRUD（モジュール内パスが /notification-settings/:userId のためプレフィックスなしでマウント）
router.use(notificationSettings.router);
// 管理者・運用向けエンドポイント（/admin/*・node-info・channels・system/info）
router.use(adminRoutes);

// --- 共通エラーハンドリング ---
router.use(errorMiddleware);

module.exports = router;
