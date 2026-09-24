// src/api/routes/admin.js - 管理者・運用向けエンドポイント
// API ルート直下にぶら下がる admin/info 系。node-info・channels・system/info は
// admin 限定（ノード公開鍵・チャネル容量・ピア情報・プロセス情報は攻撃計画を補助する）。
const express = require('express');
const router = express.Router();
const jwtAuth = require('../middleware/jwt-auth');
const rbac = require('../middleware/rbac');
const { lightning, requireService } = require('../../core/services');
const { asyncHandler } = require('../../utils/error-handler');
const { cacheMiddleware, purgeCache } = require('../middleware/cache');
const UserRepository = require('../../db/json/UserRepository');
const GpuRepository = require('../../db/json/GpuRepository');
const OrderRepository = require('../../db/json/OrderRepository');
const VerificationRepository = require('../../db/json/VerificationRepository');
const EscrowRepository = require('../../db/json/EscrowRepository');
const { expireStaleOrders, expireStaleMatchedOrders, expireStaleDisputedOrders, expireStaleActiveOrders } = require('../../utils/order-expiry');

// Lightningノード情報API（管理者のみ: ノード公開鍵・ピア情報・容量を含む）
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
  const record = VerificationRepository.getByJobId(req.params.jobId);
  if (!record) return res.status(404).json({ error: 'Verification record not found' });
  res.json(record);
}));

// エスクロー一覧（管理者のみ）— orderId・state で絞り込み可能。
// 注文当事者は GET /orders/:id/payment で自分の注文のエスクローを閲覧できるが、
// 管理者が全エスクローをクロス検索する手段がなかった。
router.get('/admin/escrow', jwtAuth, rbac('admin'), asyncHandler(async (req, res) => {
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

module.exports = router;
