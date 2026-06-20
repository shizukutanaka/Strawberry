// src/api/routes/order/index.js - オーダー関連APIルート
const express = require('express');
const router = express.Router();

// --- 利用時間セッション管理クラス ---
const usageSessions = new Map(); // orderId -> OrderUsageSession
// ハートビート頻度制限用の最終受信タイムスタンプ（"orderId:userId" → ms）
const heartbeatTimestamps = new Map();
class OrderUsageSession {
  constructor(orderId, lenderId, renterId) {
    this.orderId = orderId;
    this.lenderId = lenderId;
    this.renterId = renterId;
    this.lenderActive = false;
    this.renterActive = false;
    this.usageStart = null;
    this.accumulatedSeconds = 0;
    this.lastLenderHeartbeat = null;
    this.lastRenterHeartbeat = null;
    this.HEARTBEAT_TIMEOUT = 20 * 1000; // 20秒
  }
  onHeartbeat(userId, role) {
    const now = Date.now();
    if (role === 'lender') {
      this.lenderActive = true;
      this.lastLenderHeartbeat = now;
    } else if (role === 'renter') {
      this.renterActive = true;
      this.lastRenterHeartbeat = now;
    }
    this.updateTimer();
  }
  updateTimer() {
    const now = Date.now();
    if (this.lenderActive && this.renterActive) {
      if (!this.usageStart) this.usageStart = now;
    } else {
      if (this.usageStart) {
        this.accumulatedSeconds += Math.floor((now - this.usageStart) / 1000);
        this.usageStart = null;
      }
    }
  }
  checkTimeouts() {
    const now = Date.now();
    if (this.lastLenderHeartbeat && now - this.lastLenderHeartbeat > this.HEARTBEAT_TIMEOUT) {
      this.lenderActive = false;
      this.updateTimer();
    }
    if (this.lastRenterHeartbeat && now - this.lastRenterHeartbeat > this.HEARTBEAT_TIMEOUT) {
      this.renterActive = false;
      this.updateTimer();
    }
  }
  getUsageSeconds() {
    let total = this.accumulatedSeconds;
    if (this.usageStart) {
      total += Math.floor((Date.now() - this.usageStart) / 1000);
    }
    return total;
  }
}

// 全セッションのタイムアウト監視 + 終了済みセッションの回収。
// メモリリーク防止: /stop 以外の終端経路（delete/reject/dispute-resolve）や、
// オーダーが削除済みの孤児セッションをここで一括回収する。これがないと、
// 明示的 /stop を経ずに終了したオーダーのセッションが永久に Map に残る。
const TERMINAL_SESSION_STATUSES = new Set(['completed', 'cancelled']);
function _deleteHeartbeatsForOrder(orderId) {
  // heartbeatTimestamps のキーは `${orderId}:${userId}` 形式。
  // 該当オーダーの全ハートビートエントリを除去（メモリリーク防止）。
  const prefix = `${orderId}:`;
  for (const key of heartbeatTimestamps.keys()) {
    if (key.startsWith(prefix)) heartbeatTimestamps.delete(key);
  }
}
function reapUsageSessions() {
  // 遅延 require: モジュール末尾で定義される OrderRepository をクロージャ経由で参照する。
  const OrderRepo = require('../../../db/json/OrderRepository');
  for (const [orderId, session] of usageSessions) {
    session.checkTimeouts();
    let order = null;
    try { order = OrderRepo.getById(orderId); } catch (_) { order = null; }
    if (!order || TERMINAL_SESSION_STATUSES.has(order.status)) {
      usageSessions.delete(orderId);
      _deleteHeartbeatsForOrder(orderId);
    }
  }
}
// unref: テスト等でプロセス終了を妨げない（server.js の metricsInterval と同方針）
const sessionTimeoutInterval = setInterval(reapUsageSessions, 30000);
if (sessionTimeoutInterval.unref) sessionTimeoutInterval.unref();

const { asyncHandler, APIError, ErrorTypes } = require('../../../utils/error-handler');
const { validateMiddleware, schemas, Joi } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole, allowOwnerOrAdmin } = require('../../middleware/security');
const { withLock } = require('../../../utils/async-lock');

// コアサービスは共有のガード付きシングルトンから取得（未導入時は null）
const { p2pNetwork, vgpuManager, requireService } = require('../../../core/services');
const { v4: uuidv4 } = require('uuid');
// ファイルベースJSONストレージリポジトリ
const OrderRepository = require('../../../db/json/OrderRepository');
const GpuRepository = require('../../../db/json/GpuRepository');
// 価格計算（時間単価解決・5分単価・JPY換算）の共通ユーティリティ
const { fetchRateInfo, computeOrderPricing } = require('../../../utils/order-pricing');
// 注文イベント通知（メール/LINE/Discord/Slack/Webhook/Telegram）
const { sendNotification, NotifyType } = require('../../../utils/notifier');
// 状態遷移の妥当性チェック（未 import だと PUT /:id の status 変更で ReferenceError → 500）
const { isValidOrderTransition } = require('../../../utils/state-checker');
// 未決済 pending 注文の自動失効（一覧取得・注文作成時の遅延スイープ）
const { expireStaleOrders, expireStaleMatchedOrders, expireStaleDisputedOrders, expireStaleActiveOrders } = require('../../../utils/order-expiry');
// GPU を占有中とみなす注文ステータス（二重予約チェックに使用）
const BLOCKING_ORDER_STATUSES = new Set(['pending', 'matched', 'active']);

// 事前予約の先行上限（既定 90 日）。durationMinutes の上限は Joi スキーマ
// (validator.js: max 43200 = 30日) が担保するが、scheduledStartAt は isoDate
// 形式のみ検証され「どれだけ先か」は無制限だった。pending 注文の絶対 TTL(90日)を
// 超える先の枠を予約できると、その注文は後で必ず自動キャンセルされるのに在庫だけを
// ブロックする（在庫ブロッキング / 不可解な UX）。作成時点で先行上限を課して塞ぐ。env 上書き可。
function resolvePositiveIntEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : def;
}
const MAX_ORDER_SCHEDULE_AHEAD_DAYS = resolvePositiveIntEnv('MAX_ORDER_SCHEDULE_AHEAD_DAYS', 90); // pending TTL と整合

const { sanitizeObject, sanitizeString } = require('../../../utils/sanitize');
const { cacheMiddleware, invalidateUserCache } = require('../../middleware/cache');
// スラッシュ/係争解決/レビュー後にレピュテーションキャッシュを無効化する
let _invalidateRepCache = null;
function invalidateRepCache(userId) {
  if (!_invalidateRepCache) {
    try { _invalidateRepCache = require('../user/index').invalidateReputationCache; } catch (_) { _invalidateRepCache = () => {}; }
  }
  if (userId && typeof _invalidateRepCache === 'function') _invalidateRepCache(userId);
}

// オーダー一覧取得 (認証必須)
// キャッシュは perUser 必須: URL のみをキーにすると先行ユーザーの注文一覧が
// 他ユーザーに返る（認可バイパス）ため、ユーザーIDをキーに含める。

// Stale-order sweeps are O(N orders) reads + writes per call. Triggering them on
// every GET /orders amplified into a 4-sweep DoS — a fresh role:'user' token could
// hammer ?offset=$i (bypassing the perUser cache via varying querystring) and force
// 4×N IO per request. Throttle to once per SWEEP_THROTTLE_MS process-wide.
const SWEEP_THROTTLE_MS = process.env.NODE_ENV === 'test' ? 0 : 30_000;
let _lastOrderSweepAt = 0;
router.get('/',
  authenticateJWT,
  cacheMiddleware({ perUser: true }),
  asyncHandler(async (req, res, next) => {
    try {
      logger.info('Fetching orders');
      // 期限切れ pending/matched 注文を失効させてから一覧を返す（遅延スイープ）。
      // 30 秒に 1 回だけ実行し、リクエストごとの 4×N スキャン増幅を遮断する。
      if (Date.now() - _lastOrderSweepAt > SWEEP_THROTTLE_MS) {
        _lastOrderSweepAt = Date.now();
        expireStaleOrders();
        expireStaleMatchedOrders();
        expireStaleDisputedOrders();
        // active タイムアウト: 返された各注文の GPU を解放する（vgpuManager 利用可能時のみ）
        const timedOutActive = expireStaleActiveOrders();
        if (vgpuManager && timedOutActive.length > 0) {
          for (const { id: oid, gpuId } of timedOutActive) {
            try { await vgpuManager.releaseGPU(gpuId, oid); } catch (_) {}
          }
        }
      }
      let orders;
      if (req.user.role === 'admin') {
        orders = OrderRepository.getAll();
        // 管理者はユーザーIDやプロバイダIDで絞り込み可能（サポートワークフロー）
        if (req.query.userId) orders = orders.filter(o => o.userId === req.query.userId);
        if (req.query.providerId) orders = orders.filter(o => o.providerId === req.query.providerId);
      } else if (req.user.role === 'provider') {
        // プロバイダは自分が提供側の注文に加え、自分が借り手側の注文も閲覧できる。
        // ?role=provider でプロバイダ側のみ、?role=renter で借り手側のみ絞り込み可能。
        const allOrders = OrderRepository.getAll();
        if (req.query.role === 'provider') {
          orders = allOrders.filter(o => o.providerId === req.user.id);
        } else if (req.query.role === 'renter') {
          orders = allOrders.filter(o => o.userId === req.user.id);
        } else {
          const providerSet = new Set(allOrders.filter(o => o.providerId === req.user.id).map(o => o.id));
          const renterOrders = allOrders.filter(o => o.userId === req.user.id && !providerSet.has(o.id));
          orders = [...allOrders.filter(o => providerSet.has(o.id)), ...renterOrders];
        }
      } else {
        orders = OrderRepository.getByUserId(req.user.id);
      }
      const status = req.query.status;
      if (status) {
        orders = orders.filter(order => order.status === status);
      }
      // gpuId で絞り込み（全ロール対応 — プロバイダが特定 GPU の注文を確認する際に便利）
      if (req.query.gpuId) {
        orders = orders.filter(order => order.gpuId === req.query.gpuId);
      }
      // 日付範囲フィルタ（from=ISO&to=ISO — createdAt ベース）
      if (req.query.from) {
        const fromMs = Date.parse(req.query.from);
        if (!Number.isFinite(fromMs)) return res.status(400).json({ error: 'Invalid "from" date' });
        orders = orders.filter(o => Date.parse(o.createdAt) >= fromMs);
      }
      if (req.query.to) {
        const toMs = Date.parse(req.query.to);
        if (!Number.isFinite(toMs)) return res.status(400).json({ error: 'Invalid "to" date' });
        orders = orders.filter(o => Date.parse(o.createdAt) <= toMs);
      }
      const SORTABLE_FIELDS = new Set(['createdAt', 'updatedAt', 'status', 'totalPrice', 'durationMinutes']);
      const sortBy = SORTABLE_FIELDS.has(req.query.sortBy) ? req.query.sortBy : 'createdAt';
      const sortDir = req.query.sortDir === 'asc' ? 1 : -1;
      orders.sort((a, b) => {
        if (a[sortBy] < b[sortBy]) return -1 * sortDir;
        if (a[sortBy] > b[sortBy]) return 1 * sortDir;
        return 0;
      });
      // ページネーション（limit: 1..200 既定50 / offset: 0..）
      const total = orders.length;
      const limitRaw = parseInt(req.query.limit, 10);
      const offsetRaw = parseInt(req.query.offset, 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
      const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.min(offsetRaw, 100000) : 0;
      orders = orders.slice(offset, offset + limit);
      // リアルタイムBTC/JPY換算（レートは一覧全体で1回だけ取得して使い回す）
      const rateInfo = await fetchRateInfo();
      const ordersWithPricing = orders.map(order => ({
        ...order,
        ...computeOrderPricing(order, rateInfo)
      }));
      res.json({
        message: 'Fetched orders',
        total,
        limit,
        offset,
        orders: ordersWithPricing,
        exchangeRateTimestamp: rateInfo.timestamp
      });
    } catch (error) {
      next(error);
    }
  })
);

// ユーザー自身の注文統計 (認証必須 — 全ロール)
// 借り手として: 総支出・完了件数・キャンセル件数・係争件数
// 提供者として: 収益サマリは /provider/earnings を参照（こちらはより軽量）
router.get('/stats',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const allOrders = OrderRepository.getAll();

    const asRenter = allOrders.filter(o => o.userId === userId);
    const asProvider = req.user.role === 'provider' || req.user.role === 'admin'
      ? allOrders.filter(o => o.providerId === userId)
      : [];

    const countByStatus = (orders) => {
      const counts = {};
      for (const o of orders) {
        counts[o.status] = (counts[o.status] || 0) + 1;
      }
      return counts;
    };

    const totalSpentSats = asRenter
      .filter(o => o.status === 'completed')
      .reduce((s, o) => s + (typeof o.totalPrice === 'number' ? o.totalPrice : 0), 0);
    const totalSpentJPY = asRenter
      .filter(o => o.status === 'completed')
      .reduce((s, o) => s + (typeof o.totalPriceJPY === 'number' ? o.totalPriceJPY : 0), 0);

    const totalEarnedSats = asProvider
      .filter(o => o.status === 'completed')
      .reduce((s, o) => s + (typeof o.totalPrice === 'number' ? o.totalPrice : 0), 0);
    const totalEarnedJPY = asProvider
      .filter(o => o.status === 'completed')
      .reduce((s, o) => s + (typeof o.totalPriceJPY === 'number' ? o.totalPriceJPY : 0), 0);

    res.json({
      userId,
      asRenter: {
        total: asRenter.length,
        byStatus: countByStatus(asRenter),
        totalSpentSats,
        totalSpentJPY,
      },
      // 提供者・管理者は asProvider を常に返す（件数 0 でも null にしない）
      asProvider: (req.user.role === 'provider' || req.user.role === 'admin') ? {
        total: asProvider.length,
        byStatus: countByStatus(asProvider),
        totalEarnedSats,
        totalEarnedJPY,
      } : null,
    });
  })
);

// プロバイダ収益サマリ (認証必須, provider/admin)
// 自身が providerId の注文を集計し、完了済み収益と進行中の見込み額を返す。
router.get('/provider/earnings',
  authenticateJWT,
  checkRole(['provider', 'admin']),
  asyncHandler(async (req, res) => {
    const providerId = req.user.id;
    // 任意の日付範囲フィルタ（from=ISO&to=ISO）
    const fromMs = req.query.from ? Date.parse(req.query.from) : null;
    const toMs = req.query.to ? Date.parse(req.query.to) : null;
    if (req.query.from && isNaN(fromMs)) {
      return res.status(400).json({ error: 'Invalid from date' });
    }
    if (req.query.to && isNaN(toMs)) {
      return res.status(400).json({ error: 'Invalid to date' });
    }
    let orders = OrderRepository.getAll().filter(o => o.providerId === providerId);
    if (fromMs) orders = orders.filter(o => Date.parse(o.createdAt) >= fromMs);
    if (toMs) orders = orders.filter(o => Date.parse(o.createdAt) <= toMs);
    const summary = {
      providerId,
      from: req.query.from || null,
      to: req.query.to || null,
      completedCount: 0,
      completedSats: 0,
      completedJPY: 0,
      activeCount: 0,
      activeSats: 0,
      cancelledCount: 0,
    };
    for (const o of orders) {
      const sats = typeof o.totalPrice === 'number' ? o.totalPrice : 0;
      if (o.status === 'completed') {
        summary.completedCount++;
        summary.completedSats += sats;
        summary.completedJPY += typeof o.totalPriceJPY === 'number' ? o.totalPriceJPY : 0;
      } else if (o.status === 'active') {
        summary.activeCount++;
        summary.activeSats += sats;
      } else if (o.status === 'cancelled') {
        summary.cancelledCount++;
      }
    }
    // GPU別収益内訳
    const GpuRepository = require('../../../db/json/GpuRepository');
    const byGpu = {};
    for (const o of orders) {
      if (o.status !== 'completed') continue;
      const gid = o.gpuId;
      if (!byGpu[gid]) byGpu[gid] = { gpuId: gid, gpuName: null, completedCount: 0, completedSats: 0, completedJPY: 0 };
      byGpu[gid].completedCount++;
      byGpu[gid].completedSats += typeof o.totalPrice === 'number' ? o.totalPrice : 0;
      byGpu[gid].completedJPY += typeof o.totalPriceJPY === 'number' ? o.totalPriceJPY : 0;
    }
    for (const entry of Object.values(byGpu)) {
      const gpu = GpuRepository.getById(entry.gpuId);
      entry.gpuName = gpu ? gpu.name : null;
    }
    summary.byGpu = Object.values(byGpu).sort((a, b) => b.completedSats - a.completedSats);

    res.json({ message: 'Provider earnings summary', earnings: summary });
  })
);

// --- ハートビート受付API ---
// POST /api/orders/:id/heartbeat { role: 'lender'|'renter' }
router.post('/:id/heartbeat',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    const { role } = req.body;
    if (!['lender', 'renter'].includes(role)) {
      throw new APIError(ErrorTypes.VALIDATION, 'role must be lender or renter', 400);
    }
    // オーダー取得
    const order = OrderRepository.getById(orderId);
    if (!order) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    }
    // 権限チェック
    if ((role === 'lender' && req.user.id !== order.providerId) ||
        (role === 'renter' && req.user.id !== order.userId)) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'No permission for this order as this role', 403);
    }
    // ハートビートは active 状態のオーダーのみ受け付ける。
    // pending/matched では GPU はまだ割り当てられておらず、
    // 偽のハートビートで usageSeconds を積み上げることを防ぐ。
    // completed/cancelled はメモリリーク防止を兼ねる。
    if (order.status !== 'active') {
      throw new APIError(ErrorTypes.VALIDATION, 'Heartbeats are only accepted for active orders', 409);
    }
    // ハートビート頻度制限: 同一 (orderId, userId) で MIN_INTERVAL_MS 未満は 429 を返す。
    // 制限なしだと毎秒数千リクエストで Node.js イベントループが枯渇する（認証済みユーザーによる DoS）。
    const HB_MIN_MS = Math.max(1000, Number(process.env.HEARTBEAT_MIN_INTERVAL_MS) || 10000);
    const hbKey = `${orderId}:${req.user.id}`;
    const lastHb = heartbeatTimestamps.get(hbKey) || 0;
    const nowMs = Date.now();
    if (nowMs - lastHb < HB_MIN_MS) {
      return res.status(429).json({ error: `Heartbeat too frequent. Minimum interval: ${HB_MIN_MS / 1000}s` });
    }
    heartbeatTimestamps.set(hbKey, nowMs);
    // セッション取得または作成
    let session = usageSessions.get(orderId);
    if (!session) {
      session = new OrderUsageSession(orderId, order.providerId, order.userId);
      usageSessions.set(orderId, session);
    }
    session.onHeartbeat(req.user.id, role);
    res.json({ usageSeconds: session.getUsageSeconds() });
  })
);

// オーダー詳細取得 (認証必須)
router.get('/:id',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  allowOwnerOrAdmin((req) => OrderRepository.getById(req.params.id)),
  asyncHandler(async (req, res, next) => {
    try {
      logger.info(`Fetching order detail: ${req.params.id}`);
      const order = req.resource;
      const rateInfo = await fetchRateInfo();
      // 借り手プロフィール（プロバイダが承認/拒否判断に使えるよう注文詳細に同梱）
      const renterOrders = OrderRepository.getAll().filter(o => o.userId === order.userId && o.renterReview);
      const renterReviewCount = renterOrders.length;
      const renterRatingAverage = renterReviewCount > 0
        ? Math.round((renterOrders.reduce((s, o) => s + Math.min(5, Math.max(1, Number(o.renterReview.rating) || 1)), 0) / renterReviewCount) * 10) / 10
        : null;
      // ステータス変遷タイムライン（既存タイムスタンプを時系列に整列）
      const timeline = [
        { status: 'pending',   at: order.createdAt || null },
        { status: 'matched',   at: order.matchedAt || null },
        { status: 'active',    at: order.startedAt || null },
        { status: 'completed', at: order.completedAt || null },
        { status: 'cancelled', at: order.cancelledAt || null },
        { status: 'disputed',  at: order.dispute ? order.dispute.raisedAt : null },
      ].filter(e => e.at).sort((a, b) => a.at.localeCompare(b.at));
      res.json({
        message: 'Fetched order detail',
        order: {
          ...order,
          ...computeOrderPricing(order, rateInfo),
          renterProfile: { ratingAverage: renterRatingAverage, reviewCount: renterReviewCount },
          timeline,
        },
        exchangeRateTimestamp: rateInfo.timestamp
      });
    } catch (error) {
      next(error);
    }
  })
);

// オーダーの課金・エスクロー状況（注文当事者＝借り手/プロバイダ/管理者のみ）
// これまで支払状況は別の paymentId 経由（支払者しか知らない）、エスクローは管理者限定でしか
// 見えず、注文当事者が自分の注文の決済状態を確認できなかった。orderId 起点で一括照会する。
router.get('/:id/payment',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  allowOwnerOrAdmin((req) => OrderRepository.getById(req.params.id)),
  asyncHandler(async (req, res) => {
    const order = req.resource;
    const PaymentRepository = require('../../../db/json/PaymentRepository');
    const EscrowRepository = require('../../../db/json/EscrowRepository');

    const payments = (PaymentRepository.getByOrderId(order.id) || []).map(p => ({
      id: p.id,
      status: p.status,
      amount: p.amount,
      method: p.method,
      paidAt: p.paidAt || null,
      invoiceExpiresAt: p.invoiceExpiresAt || null,
    }));
    const escrows = (EscrowRepository.getByOrderId(order.id) || []).map(e => ({
      id: e.id,
      state: e.state,
      amountSats: e.amountSats,
      feeRate: e.feeRate,
      createdAt: e.createdAt || null,
    }));

    res.json({
      orderId: order.id,
      orderStatus: order.status,
      totalPrice: typeof order.totalPrice === 'number' ? order.totalPrice : null,
      totalPriceJPY: typeof order.totalPriceJPY === 'number' ? order.totalPriceJPY : null,
      payments,
      escrows,
    });
  })
);

// オーダー更新 (認証必須)
router.put('/:id',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  allowOwnerOrAdmin((req) => OrderRepository.getById(req.params.id)),
  asyncHandler(async (req, res) => {
    const order = req.resource;
    // PUT is the renter's (order creator's) edit path. allowOwnerOrAdmin also grants
    // access when req.user.id === order.providerId, but providers must use the
    // dedicated /accept and /reject endpoints — not PUT — to avoid unauthorized
    // mutation of the renter's record (e.g., evidence tampering before a dispute).
    if (req.user.role !== 'admin' && order.userId !== req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Only the order creator or an admin can edit order fields. Providers must use /accept or /reject.', 403);
    }
    logger.info(`Updating order: ${order.id}`);
    // 入力値サニタイズ
    const sanitized = sanitizeObject(req.body, ['description', 'notes']);
    // ステータス変更は管理者専用（専用エンドポイント /accept /reject /start /stop /dispute を使う）。
    // 一般ユーザー（借り手・提供者）が PUT で status を直接操作できると正規フローを迂回できる:
    //   - 借り手が pending→matched や matched→active にすることで提供者確認をスキップ
    //   - 提供者が active→completed にすることで /stop のエスクロー決済をスキップ
    if (sanitized.status && sanitized.status !== order.status) {
      if (req.user.role !== 'admin') {
        throw new APIError(ErrorTypes.FORBIDDEN, 'Only admins can change order status via this endpoint. Use the dedicated endpoints (/accept, /reject, /start, /stop, /dispute)', 403);
      }
      if (!isValidOrderTransition(order.status, sanitized.status)) {
        return res.status(400).json({ error: `Invalid status transition from ${order.status} to ${sanitized.status}` });
      }
      // 'disputed' への直接遷移は POST /:id/dispute のみが正規ルート。
      // admin PUT で transition させると order.dispute オブジェクトが存在しない状態になり、
      // /dispute/resolve の raisedBy 参照や係争グリーフィングゲートが正しく機能しなくなる。
      if (sanitized.status === 'disputed') {
        throw new APIError(ErrorTypes.VALIDATION,
          "Use POST /:id/dispute to raise a dispute. Setting status to 'disputed' directly is not allowed.",
          400);
      }
    }
    // フィールドフィルタ: 非管理者は description/notes のみ変更可能。
    // これがないと借り手が { totalPrice: 1, pricePerHour: 0.001 } を PUT して
    // 合意済み金額を事後改竄できてしまう（管理者は status 含む全フィールドを操作可）。
    const MUTABLE_BY_OWNER = new Set(['description', 'notes']);
    const updateData = req.user.role === 'admin'
      ? sanitized
      : Object.fromEntries(Object.entries(sanitized).filter(([k]) => MUTABLE_BY_OWNER.has(k)));
    // オーダーを更新（update() は内部で merge するため delta のみ渡す。
    // 旧コードの { ...order, ...sanitized } は getById〜update 間の並行書き込みを上書きする
    // stale-spread anti-pattern だった）
    const prevStatus = order.status;
    const updatedOrder = OrderRepository.update(order.id, updateData);
    logger.info(`Order updated: ${order.id}`);
    invalidateUserCache(req.user.id);
    if (order.providerId && order.providerId !== req.user.id) invalidateUserCache(order.providerId);
    // ステータスが matched または active に変わった場合は借り手へ通知
    if (updateData.status && updateData.status !== prevStatus) {
      try {
        const { notifyUser } = require('../../../utils/user-notify');
        if (updateData.status === 'matched') {
          notifyUser(order.userId, 'order_matched',
            `【Strawberry】注文がマッチしました\n注文: #${order.id}\nまもなく利用を開始できます`,
            { subject: `【Strawberry】注文 #${order.id} マッチング完了` });
        } else if (updateData.status === 'active') {
          notifyUser(order.userId, 'order_started',
            `【Strawberry】GPU の利用が開始されました\n注文: #${order.id}`,
            { subject: `【Strawberry】注文 #${order.id} 利用開始` });
        }
      } catch (_) { /* 通知失敗は更新を妨げない */ }
    }
    res.json({
      message: 'Order updated successfully',
      order: updatedOrder
    });
  })
);

// オーダー削除 (認証必須)
router.delete('/:id',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  allowOwnerOrAdmin((req) => OrderRepository.getById(req.params.id)),
  asyncHandler(async (req, res) => {
    const order = req.resource;
    // DELETE (soft-cancel) is the renter's self-cancel path. allowOwnerOrAdmin also
    // admits providers via order.providerId, but providers must use POST /:id/reject.
    // Allowing providers here lets them forge a 'user_cancelled' reason, forfeiting
    // the renter's escrow deposit and breaking dispute resolution.
    if (req.user.role !== 'admin' && order.userId !== req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Only the order creator or an admin can cancel an order via DELETE. Providers must use POST /:id/reject.', 403);
    }
    logger.info(`Deleting order: ${order.id}`);
    // 状態チェック
    if (!['pending', 'matched'].includes(order.status)) {
      throw new APIError(ErrorTypes.VALIDATION, 'Only pending or matched orders can be deleted', 400);
    }
    // エスクローが存在する場合は返金キャンセルを試みる（ベストエフォート）
    try {
      const EscrowRepository = require('../../../db/json/EscrowRepository');
      const escrows = EscrowRepository.getByOrderId(order.id);
      if (Array.isArray(escrows) && escrows.length > 0) {
        const { createEscrowService } = require('../../../payments/escrow-service');
        const escrowSvc = createEscrowService();
        for (const escrow of escrows) {
          if (!['CANCELED', 'SETTLED'].includes(escrow.state)) {
            try { escrowSvc.cancel(escrow.id); } catch (e) {
              logger.warn(`Escrow cancel failed for ${escrow.id}: ${e.message}`);
            }
          }
        }
      }
    } catch (e) {
      logger.warn(`Escrow lookup on order delete failed (order=${order.id}): ${e.message}`);
    }
    // ハード削除ではなくソフトキャンセル（audit trail / 係争 / 統計を保全）
    OrderRepository.update(order.id, {
      status: 'cancelled',
      cancelReason: 'user_cancelled',
      cancelledAt: new Date().toISOString(),
    });
    // プロバイダへキャンセル通知（予約した GPU が開放されたことを即時連絡）
    if (order.providerId) {
      try {
        const { notifyUser } = require('../../../utils/user-notify');
        const cancelledGpu = GpuRepository.getById(order.gpuId);
        const gpuLabel = cancelledGpu ? cancelledGpu.name : order.gpuId;
        notifyUser(order.providerId, 'order_cancelled',
          `【Strawberry】注文がキャンセルされました\n注文: #${order.id}\nGPU: ${gpuLabel}`,
          { subject: `【Strawberry】注文 #${order.id} キャンセル通知` });
      } catch (_) { /* 通知失敗はキャンセル処理を妨げない */ }
    }
    logger.info(`Order cancelled (soft-delete): ${order.id}`);
    invalidateUserCache(req.user.id);
    if (order.providerId && order.providerId !== req.user.id) invalidateUserCache(order.providerId);
    res.json({ message: 'Order cancelled', orderId: order.id });
  })
);

// オーダー作成 (認証必須)
router.post('/', 
  authenticateJWT,
  validateMiddleware(schemas.order.create),
  asyncHandler(async (req, res) => {
    // 入力値サニタイズ
    const orderData = sanitizeObject(req.validatedBody, ['description']);
    logger.info('Creating new order');
    // durationMinutes必須・5の倍数・整数のみ許可
    const durationMinutes = Number(orderData.durationMinutes);
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes % 5 !== 0) {
      throw new APIError(ErrorTypes.VALIDATION, 'durationMinutes must be a positive integer and a multiple of 5 (minutes)', 400);
    }
    // 注: durationMinutes の上限(30日 = 43200分)は schemas.order.create(Joi) が担保する。
    orderData.durationMinutes = durationMinutes;

    // gpuId必須化（maxPricePerHourとの排他チェック）
    if (!orderData.gpuId) {
      throw new APIError(ErrorTypes.VALIDATION, 'gpuId is required', 400);
    }
    if (orderData.gpuId && orderData.maxPricePerHour) {
      throw new APIError(ErrorTypes.VALIDATION, 'Specify either gpuId or maxPricePerHour, not both', 400);
    }

    // GPUの存在チェック
    const gpu = GpuRepository.getById(orderData.gpuId);
    if (!gpu) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Specified GPU not found', 404);
    }
    // 自己取引（ウォッシュトレード）防止: プロバイダは自分の GPU を注文できない。
    // これを許すと、注文→完了で recordJobResult(true) により自分の評判を、
    // 自己レビューで自分の GPU 評価を、いずれも無から捏造できてしまう（信頼層の偽造）。
    if (gpu.providerId && gpu.providerId === req.user.id) {
      throw new APIError(ErrorTypes.VALIDATION, 'You cannot order your own GPU', 400);
    }
    // GPU 利用可能性チェック: プロバイダが明示的に無効化した GPU は予約不可。
    // GET /gpus リストはフロントエンド向けの表示フィルタだが、gpuId を知っていれば
    // リストに出なくても直接 POST /orders で予約できてしまう(バイパス)のでここで防ぐ。
    if (gpu.available === false) {
      throw new APIError(ErrorTypes.CONFLICT, 'GPU is not available for booking', 409);
    }
    // 手動ブロック期間との重複チェック（プロバイダが整備/メンテのため予約を止めた時間帯）。
    // double-booking チェックはオーダーステータス基準なのでこちらも必要。
    const reqStart = new Date(orderData.scheduledStartAt || Date.now()).getTime();
    const reqEnd = reqStart + durationMinutes * 60 * 1000;
    if (Array.isArray(gpu.manualBlocks)) {
      const blocked = gpu.manualBlocks.find(b => {
        const bs = new Date(b.from).getTime();
        const be = new Date(b.to).getTime();
        return Number.isFinite(bs) && Number.isFinite(be) && reqStart < be && reqEnd > bs;
      });
      if (blocked) {
        throw new APIError(ErrorTypes.CONFLICT,
          `GPU is manually blocked during the requested period (blocked until ${blocked.to})`, 409);
      }
    }
    // 借り手レーティングフロア: GPU に minRenterRating が設定されている場合、
    // 十分なレビュー実績を持つ借り手はその平均評価が floor を下回ると 422 で拒否される。
    // レビュー実績がない新規借り手は通過させる（初回拒絶ループ防止）。
    const renterOrders = OrderRepository.getAll().filter(o => o.userId === req.user.id && o.renterReview);
    const renterReviewCount = renterOrders.length;
    const renterRatingAverage = renterReviewCount > 0
      ? renterOrders.reduce((s, o) => s + Math.min(5, Math.max(1, Number(o.renterReview.rating) || 1)), 0) / renterReviewCount
      : null;
    if (gpu.minRenterRating && renterRatingAverage !== null && renterRatingAverage < gpu.minRenterRating) {
      throw new APIError(ErrorTypes.VALIDATION,
        `This GPU requires a minimum renter rating of ${gpu.minRenterRating} (your current rating: ${Math.round(renterRatingAverage * 10) / 10})`, 422);
    }
    // 料金計算: GPUのpricePerHour必須
    let pricePerHour = gpu.pricePerHour;
    if (!pricePerHour || typeof pricePerHour !== 'number' || pricePerHour <= 0) {
      throw new APIError(ErrorTypes.VALIDATION, 'GPU pricePerHour must be a positive number', 400);
    }

    // 洪水防止: 2 段階チェック（単一 getAll() で両チェックを完結させ余分な I/O を避ける）。
    // fetchRateInfo より先にチェックし、上限超過の場合は高コストなネットワーク I/O を回避。
    const MAX_GLOBAL_PENDING_PER_USER = Number(process.env.MAX_PENDING_ORDERS_PER_USER) || 50;
    const MAX_PENDING_ORDERS_PER_USER_GPU = 5;
    const userBlockingOrders = OrderRepository.getAll().filter(
      (o) => o.userId === req.user.id && BLOCKING_ORDER_STATUSES.has(o.status)
    );
    if (userBlockingOrders.length >= MAX_GLOBAL_PENDING_PER_USER) {
      throw new APIError(
        ErrorTypes.CONFLICT,
        `You have reached the global limit of ${MAX_GLOBAL_PENDING_PER_USER} active/pending orders. Complete or cancel existing orders before creating more.`,
        409
      );
    }
    const userPendingForGpu = userBlockingOrders.filter((o) => o.gpuId === orderData.gpuId).length;
    if (userPendingForGpu >= MAX_PENDING_ORDERS_PER_USER_GPU) {
      throw new APIError(
        ErrorTypes.CONFLICT,
        `You already have ${MAX_PENDING_ORDERS_PER_USER_GPU} active orders for this GPU. Complete or cancel existing orders before creating more.`,
        409
      );
    }

    // 冗長化為替APIで換算（キャッシュ活用）— await を競合チェックの前に移動して
    // チェック→作成の間にイベントループの yield が発生しないようにし、二重予約レースを防ぐ。
    const { rate: satoshiToJPY } = await fetchRateInfo();

    // 二重予約チェック: 期限切れ pending を先に失効させ、時間帯の重複を確認する。
    // scheduledStartAt が指定された場合はカレンダー予約として時間帯重複を検査し、
    // 指定がない場合は即時予約として全 BLOCKING 注文と重複とみなす。
    // 重要: このチェックから OrderRepository.create() までの間に await を置かないこと。
    // Node.js のシングルスレッドモデルにより、同期処理は割り込みなしに実行される。
    expireStaleOrders();
    expireStaleMatchedOrders();
    // Reject scheduledStartAt more than 5 minutes in the past (allows clock-drift
    // but prevents creating orders for historical dates that bypass booking checks).
    if (orderData.scheduledStartAt) {
      const schedMs = new Date(orderData.scheduledStartAt).getTime();
      if (!Number.isFinite(schedMs)) {
        throw new APIError(ErrorTypes.VALIDATION, 'scheduledStartAt is not a valid date', 400);
      }
      if (schedMs < Date.now() - 5 * 60 * 1000) {
        throw new APIError(ErrorTypes.VALIDATION,
          'scheduledStartAt must not be more than 5 minutes in the past', 400);
      }
      // 先行予約の上限: pending 注文の絶対 TTL(90日)を超える枠は、後で必ず自動
      // キャンセルされる（在庫を無駄にブロックするだけ）ため作成時点で拒否する。
      const maxAheadMs = MAX_ORDER_SCHEDULE_AHEAD_DAYS * 24 * 60 * 60 * 1000;
      if (schedMs > Date.now() + maxAheadMs) {
        throw new APIError(ErrorTypes.VALIDATION,
          `scheduledStartAt must not be more than ${MAX_ORDER_SCHEDULE_AHEAD_DAYS} days in the future`, 400);
      }
    }
    const newStart = new Date(orderData.scheduledStartAt || Date.now()).getTime();
    const newEnd = newStart + durationMinutes * 60 * 1000;
    const blocking = OrderRepository.getAll().find(o => {
      if (o.gpuId !== orderData.gpuId) return false;
      if (!BLOCKING_ORDER_STATUSES.has(o.status)) return false;
      const existingStart = new Date(o.scheduledStartAt || o.createdAt).getTime();
      const existingEnd = existingStart + (o.durationMinutes || 0) * 60 * 1000;
      return newStart < existingEnd && newEnd > existingStart;
    });
    if (blocking) {
      throw new APIError(
        ErrorTypes.CONFLICT,
        `GPU is not available: an order in '${blocking.status}' state already exists for this GPU at the requested time`,
        409
      );
    }

    // ユーザーIDを設定
    orderData.userId = req.user.id;
    // GPU プロバイダ ID を注文に記録（allowOwnerOrAdmin でプロバイダが自分の GPU 上の注文を管理できるようにする）
    orderData.providerId = gpu.providerId || null;
    // オーダーステータスを設定
    orderData.status = 'pending';
    // 予約時間帯を確定（scheduledStartAt 未指定 = 即時）
    orderData.scheduledStartAt = orderData.scheduledStartAt || new Date().toISOString();
    orderData.scheduledEndAt = new Date(new Date(orderData.scheduledStartAt).getTime() + durationMinutes * 60 * 1000).toISOString();
    // 5分単価
    const pricePer5Min = pricePerHour / 12;
    // totalPrice は整数 sats へ丸める（computeOrderPricing と同一規則）。丸めないと
    // 注文作成時に保存・表示する totalPrice が、支払い時に再計算される額と食い違う。
    // 1 satoshi はビットコインの最小不可分単位。pricePerHour > 0（上で検証済み）の有償注文が
    // 丸めで 0 sat になると「無料レンタル」かつ「支払い不能(btc-onchain は 0 を拒否)」になるため、
    // 正の生額は最小 1 sat に切り上げる（端数 0.25 sat の注文も実際には 1 sat 課金される）。
    const rawTotal = pricePer5Min * (durationMinutes / 5);
    const totalPrice = rawTotal > 0 ? Math.max(1, Math.round(rawTotal)) : 0;
    const totalPriceJPY = Math.round(totalPrice * satoshiToJPY);
    // ファイル永続化リポジトリで作成
    // 価格ロック: 合意時の時間単価を注文に固定する。これが無いと支払い時の
    // computeOrderPricing が GPU の「現在価格」へフォールバックし、プロバイダが注文後に
    // 値上げするとレンターが合意額より高く課金される（見積りの拘束力が失われる）バグになる。
    orderData.pricePerHour = pricePerHour;
    orderData.totalPrice = totalPrice;
    orderData.totalPriceJPY = totalPriceJPY;
    const createdOrder = OrderRepository.create(orderData);
    // 通知サービス呼び出し
    const notifyMsg = `新規注文: #${createdOrder.id}\nユーザー: ${req.user.id}\nGPU: ${gpu.name}\n時間: ${durationMinutes}分\n合計: ${totalPrice} sat (${totalPriceJPY}円)`;
    // GPU 提供者（プロバイダ）へ通知（notification-settings で登録したチャネルへ）
    if (gpu.providerId) {
      const { notifyUser } = require('../../../utils/user-notify');
      const renterRatingStr = renterRatingAverage !== null
        ? `借り手評価: ★${Math.round(renterRatingAverage * 10) / 10}（${renterReviewCount}件）\n`
        : '借り手評価: 未評価（新規）\n';
      notifyUser(gpu.providerId, 'order_created',
        `【Strawberry】あなたの GPU に注文が入りました\n注文: #${createdOrder.id}\nGPU: ${gpu.name}\n${renterRatingStr}時間: ${durationMinutes}分\n報酬: ${totalPrice} sat (${totalPriceJPY}円)`,
        { subject: `【Strawberry】新規注文 #${createdOrder.id}（${gpu.name}）` });
    }
    // メール通知（ユーザーのメールアドレスが取得できる場合のみ）
    if (req.user.email) {
      sendNotification(NotifyType.EMAIL, notifyMsg, {
        to: req.user.email,
        subject: `【Strawberry】新規注文 #${createdOrder.id} 受付通知`,
        text: notifyMsg
      }).catch(() => {});
    }
    // 環境変数から通知先を取得（例: LINE_TOKEN, DISCORD_WEBHOOK, SLACK_WEBHOOK, GENERIC_WEBHOOK）
    if (process.env.LINE_TOKEN) {
      sendNotification(NotifyType.LINE, notifyMsg, { token: process.env.LINE_TOKEN }).catch(() => {});
    }
    if (process.env.DISCORD_WEBHOOK) {
      sendNotification(NotifyType.DISCORD, notifyMsg, { webhookUrl: process.env.DISCORD_WEBHOOK }).catch(() => {});
    }
    if (process.env.SLACK_WEBHOOK) {
      sendNotification(NotifyType.SLACK, notifyMsg, { webhookUrl: process.env.SLACK_WEBHOOK }).catch(() => {});
    }
    if (process.env.GENERIC_WEBHOOK) {
      sendNotification(NotifyType.WEBHOOK, notifyMsg, { webhookUrl: process.env.GENERIC_WEBHOOK }).catch(() => {});
    }
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      sendNotification(NotifyType.TELEGRAM, notifyMsg, {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
      }).catch(() => {});
    }
    // Googleカレンダー連携（非同期で実行、失敗はログのみ。googleapis は optional）
    try {
      const { addEventToCalendar } = require('../../../utils/google-calendar');
      const startDate = new Date();
      const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
      addEventToCalendar({
        summary: `GPU予約 #${createdOrder.id}`,
        description: `ユーザー: ${req.user.id}\nGPU: ${gpu.name}\n合計: ${totalPrice} sat (${totalPriceJPY}円)`,
        start: { dateTime: startDate.toISOString() },
        end: { dateTime: endDate.toISOString() },
      }).catch(err => logger.error('Googleカレンダー登録失敗', { error: err.message }));
    } catch (e) {
      logger.error('Googleカレンダー連携モジュール読込失敗', { error: e.message });
    }
    // オーダーイベントをログに記録
    logger.info(`Order created: ${createdOrder.id}`, {
      orderId: createdOrder.id,
      userId: req.user.id,
      gpuRequirements: createdOrder.gpuRequirements,
      pricePerHour,
      durationMinutes,
      totalPrice,
      totalPriceJPY
    });
    // 注文作成後に借り手のキャッシュを即時無効化（60秒 TTL を待たず最新一覧が見える）
    invalidateUserCache(req.user.id);
    res.status(201).json({
      message: 'Order created successfully',
      orderId: createdOrder.id,
      order: {
        ...createdOrder,
        pricePerHour,
        pricePer5Min,
        totalPrice,
        totalPriceJPY
      }
    });
  })
);

// プロバイダによる注文拒否（GPU 所有者専用 — pending のみ許可）
// POST /orders/:id/reject { reason?: string }
router.post('/:id/reject',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const order = OrderRepository.getById(req.params.id);
    if (!order) throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);

    // プロバイダまたは admin のみ許可
    // order.providerId は注文作成時に確定させる（GPU 再代入後の乗っ取りを防ぐ）
    const isProvider = order.providerId && order.providerId === req.user.id;
    if (req.user.role !== 'admin' && !isProvider) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Only the GPU provider or admin can reject an order', 403);
    }
    const gpu = GpuRepository.getById(order.gpuId);
    if (order.status !== 'pending') {
      throw new APIError(ErrorTypes.VALIDATION, `Cannot reject order in '${order.status}' state (only pending orders can be rejected)`, 400);
    }
    const cancelNote = req.body.reason ? sanitizeString(String(req.body.reason)).slice(0, 500) : '';
    // TOCTOU防止: reject と DELETE/accept が同時実行された場合どちらか一方のみ通過させる。
    const rejectResult = OrderRepository.updateIf(order.id, (o) => o.status === 'pending', {
      status: 'cancelled',
      cancelReason: 'provider_rejected',
      cancelNote,
      cancelledAt: new Date().toISOString(),
    });
    if (!rejectResult.ok) {
      throw new APIError(ErrorTypes.CONFLICT, 'Order status changed before reject could complete; please retry', 409);
    }
    // エスクローが存在する場合は返金キャンセルを試みる（ベストエフォート）
    try {
      const EscrowRepository = require('../../../db/json/EscrowRepository');
      const escrows = EscrowRepository.getByOrderId(order.id);
      if (Array.isArray(escrows) && escrows.length > 0) {
        const { createEscrowService } = require('../../../payments/escrow-service');
        const escrowSvc = createEscrowService();
        for (const escrow of escrows) {
          if (!['CANCELED', 'SETTLED'].includes(escrow.state)) {
            try { escrowSvc.cancel(escrow.id); } catch (e) {
              logger.warn(`Escrow cancel failed on reject (id=${escrow.id}): ${e.message}`);
            }
          }
        }
      }
    } catch (e) {
      logger.warn(`Escrow lookup on order reject failed (order=${order.id}): ${e.message}`);
    }
    // 借り手（レンター）へ通知
    const { notifyUser } = require('../../../utils/user-notify');
    const gpuName = gpu ? gpu.name : order.gpuId;
    notifyUser(order.userId, 'order_rejected',
      `【Strawberry】プロバイダがあなたの注文を拒否しました\n注文: #${order.id}\nGPU: ${gpuName}${cancelNote ? `\n理由: ${cancelNote}` : ''}`,
      { subject: `【Strawberry】注文 #${order.id} が拒否されました` });
    logger.info(`Order rejected by provider: ${order.id}`, { orderId: order.id, providerId: req.user.id, cancelNote });
    invalidateUserCache(order.userId);
    if (order.providerId) invalidateUserCache(order.providerId);
    res.json({ message: 'Order rejected', orderId: order.id });
  })
);

// プロバイダによる注文の明示的承認 (pending → matched)
// POST /:id/accept — GPU オーナーまたは admin のみ
// 自動マッチングを使わず、プロバイダが手動で注文を確認・承認するフロー。
router.post('/:id/accept',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const order = OrderRepository.getById(req.params.id);
    if (!order) throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);

    // order.providerId は注文作成時に確定させる（GPU 再代入後の乗っ取りを防ぐ）
    const isProvider = order.providerId && order.providerId === req.user.id;
    if (req.user.role !== 'admin' && !isProvider) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Only the GPU provider or admin can accept an order', 403);
    }
    if (order.status !== 'pending') {
      throw new APIError(ErrorTypes.VALIDATION, `Cannot accept order in '${order.status}' state (only pending orders can be accepted)`, 400);
    }
    const gpu = GpuRepository.getById(order.gpuId);
    const now = new Date().toISOString();
    // TOCTOU防止: accept と reject/DELETE が同時実行された場合どちらか一方のみ通過させる。
    const acceptResult = OrderRepository.updateIf(order.id, (o) => o.status === 'pending', {
      status: 'matched',
      matchedAt: now,
      updatedAt: now,
    });
    // updateIf は常にオブジェクト({ok, row} or {ok:false, reason, current})を返す。
    // !acceptResult は決して true にならないため CAS 失敗時に renter に "accepted" 通知が
    // 飛び、reject 側で cancelled になっているのに matched と返してしまう不整合が出ていた。
    if (!acceptResult.ok) {
      throw new APIError(ErrorTypes.CONFLICT, 'Order status changed before accept could complete; please retry', 409);
    }
    const { notifyUser } = require('../../../utils/user-notify');
    const gpuName = gpu ? gpu.name : order.gpuId;
    notifyUser(order.userId, 'order_accepted',
      `【Strawberry】プロバイダがあなたの注文を承認しました\nGPU: ${gpuName}\n注文: #${order.id}`,
      { subject: `【Strawberry】注文 #${order.id} が承認されました` });
    logger.info(`Order accepted by provider: ${order.id}`, { orderId: order.id, providerId: req.user.id });
    invalidateUserCache(order.userId);
    invalidateUserCache(req.user.id);
    res.json({ message: 'Order accepted', orderId: order.id, status: 'matched' });
  })
);

// 係争申請（active/matched 注文の当事者〈借り手 or プロバイダ〉が管理者介入を要求）
// POST /orders/:id/dispute { reason: string }
// 管理者は別途 POST /api/v1/marketplace/escrow/:id/resolve で決済する。
router.post('/:id/dispute',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const order = OrderRepository.getById(req.params.id);
    if (!order) throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);

    const isOwner = order.userId === req.user.id;
    const isProvider = order.providerId && order.providerId === req.user.id;
    if (req.user.role !== 'admin' && !isOwner && !isProvider) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Only the order owner, GPU provider, or admin can raise a dispute', 403);
    }
    if (order.dispute) {
      throw new APIError(ErrorTypes.CONFLICT, 'A dispute has already been raised for this order', 409);
    }
    if (!['active', 'matched'].includes(order.status)) {
      throw new APIError(ErrorTypes.VALIDATION, `Cannot dispute an order in '${order.status}' state (only active or matched orders can be disputed)`, 400);
    }
    // matched状態の係争は支払い済みの場合のみ許可（無支払いでプロバイダGPUをDoSする攻撃を防止）
    if (order.status === 'matched' && req.user.role !== 'admin') {
      const PaymentRepository = require('../../../db/json/PaymentRepository');
      const payments = PaymentRepository.getByOrderId(order.id) || [];
      const hasPaidPayment = payments.some(p => p.status === 'paid');
      if (!hasPaidPayment) {
        throw new APIError(ErrorTypes.FORBIDDEN, 'Cannot dispute a matched order without confirmed payment. Complete payment first or wait for the provider to start the session.', 402);
      }
    }
    // 連続グリーフィング防止 — ただし「率」で判定する（#23 の絶対カウント永久バンを是正）。
    // プロバイダ評判が成功「率」(Bayesian)で測られるのと対称に、申請者も棄却「率」で測る。
    // 正当な係争(vindicated)を起こせば率が下がり回復できる＝単調な永久ペナルティにしない。
    // ゲート発火条件: 解決済み係争が最小サンプル以上 かつ 棄却率が閾値以上（管理者は対象外）。
    if (req.user.role !== 'admin') {
      const MIN_RESOLVED = Number(process.env.MIN_RESOLVED_DISPUTES) || 3;
      const MAX_DENIED_RATE = Number(process.env.MAX_DENIED_DISPUTE_RATE) || 0.67;
      const UserRepository = require('../../../db/json/UserRepository');
      const me = UserRepository.getById(req.user.id);
      const denied = (me && me.deniedDisputeCount) || 0;
      const vindicated = (me && me.vindicatedDisputeCount) || 0;
      const resolved = denied + vindicated;
      if (resolved >= MIN_RESOLVED && denied / resolved >= MAX_DENIED_RATE) {
        throw new APIError(ErrorTypes.FORBIDDEN,
          `Too high a share of your disputes have been denied (${denied}/${resolved}); raise legitimate disputes or contact support`, 403);
      }
      // 未解決係争の絶対数上限: 解決歴がないアカウントでも複数の未解決係争でプロバイダを
      // DoS できるため（1件/注文の制限はあるが多数の注文で迂回可能）。
      const MAX_OPEN_DISPUTES = Number(process.env.MAX_OPEN_DISPUTES_PER_USER) || 3;
      const openDisputes = OrderRepository.getAll().filter(
        (o) => o.dispute && o.dispute.raisedBy === req.user.id && o.status === 'disputed'
      ).length;
      if (openDisputes >= MAX_OPEN_DISPUTES) {
        throw new APIError(ErrorTypes.CONFLICT,
          `You already have ${MAX_OPEN_DISPUTES} open disputes. Wait for existing disputes to be resolved before raising new ones.`,
          409
        );
      }
    }
    const reason = req.body.reason ? sanitizeString(String(req.body.reason)).slice(0, 1000) : '';
    const dispute = { raisedBy: req.user.id, reason, raisedAt: new Date().toISOString() };
    // TOCTOU防止: 並行 dispute リクエストや stop との競合を防ぐ。
    const disputeResult = OrderRepository.updateIf(
      order.id,
      (o) => ['active', 'matched'].includes(o.status) && !o.dispute,
      { status: 'disputed', dispute }
    );
    if (!disputeResult.ok) {
      throw new APIError(ErrorTypes.CONFLICT, 'Order status changed before dispute could be raised; please retry', 409);
    }

    // 管理者・運営側へ通知（ユーザー通知設定経由）
    const { notifyUser } = require('../../../utils/user-notify');
    const gpu = GpuRepository.getById(order.gpuId);
    const gpuName = gpu ? gpu.name : order.gpuId;
    notifyUser(order.userId, 'order_dispute_raised',
      `【Strawberry】注文 #${order.id} に係争が申請されました。\nGPU: ${gpuName}${reason ? `\n理由: ${reason}` : ''}`,
      { subject: `【Strawberry】係争申請: 注文 #${order.id}` });
    if (order.providerId && order.providerId !== req.user.id) {
      notifyUser(order.providerId, 'order_dispute_raised',
        `【Strawberry】あなたの GPU 注文に係争が申請されました。\n注文: #${order.id}\nGPU: ${gpuName}`,
        { subject: `【Strawberry】係争申請: 注文 #${order.id}` });
    }
    logger.info(`Dispute raised for order: ${order.id}`, { orderId: order.id, raisedBy: req.user.id });
    invalidateUserCache(order.userId);
    if (order.providerId) invalidateUserCache(order.providerId);
    res.status(201).json({ message: 'Dispute raised', orderId: order.id, dispute });
  })
);

// 係争の裁定（管理者のみ）— 宙ぶらりんの disputed 注文を終端状態へ遷移させ、
// かつ「実フロー」のレピュテーションへ失敗を反映する（これまで失敗系は抽象 auction 経路でしか
// 記録されず、実際の注文ライフサイクルでは reputation が単調増加しかしなかった欠陥を是正）。
// POST /orders/:id/dispute/resolve { decision: 'refund'|'uphold', note?: string }
//  - refund: 借り手勝訴（プロバイダ過失）→ 注文を cancelled、エスクロー返金、
//            provider に recordJobResult(false) + slash（評判を減点）。
//  - uphold: 係争棄却（プロバイダ正当）→ 注文を completed、provider に recordJobResult(true)。
router.post('/:id/dispute/resolve',
  authenticateJWT,
  checkRole(['admin']),
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    // 二重裁定の副作用（reputation slash + credit が両方走る、raiser counter の二重加算など）
    // を防ぐため、order 単位の mutex で全フローを直列化する。CAS だけだと CAS 前の副作用
    // （raiser の getById+update、reputation の getById+update）が並行に走り得る。
    return withLock(`order:${orderId}:dispute-resolve`, async () => {
    const order = OrderRepository.getById(orderId);
    if (!order) throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    if (order.status !== 'disputed') {
      throw new APIError(ErrorTypes.VALIDATION, `Only disputed orders can be resolved (current: '${order.status}')`, 400);
    }
    const decision = req.body.decision;
    if (!['refund', 'uphold'].includes(decision)) {
      throw new APIError(ErrorTypes.VALIDATION, "decision must be 'refund' or 'uphold'", 400);
    }
    const note = req.body.note ? sanitizeString(String(req.body.note)).slice(0, 1000) : '';
    const resolvedAt = new Date().toISOString();
    const resolution = { decision, note, resolvedBy: req.user.id, resolvedAt };

    const { notifyUser } = require('../../../utils/user-notify');
    const gpu = GpuRepository.getById(order.gpuId);
    const gpuName = gpu ? gpu.name : order.gpuId;

    // TOCTOU防止: 二重裁定による reputation/escrow 副作用の二重実行を防ぐ。
    // updateIf が null を返した場合は別の管理者リクエストが先に状態遷移済みなので 409 を返す。
    if (decision === 'refund') {
      // 注文を終端へ（cancelled）。dispute オブジェクトに裁定結果を併記。
      const resolveRefundResult = OrderRepository.updateIf(order.id, (o) => o.status === 'disputed', {
        status: 'cancelled',
        cancelReason: 'dispute_resolved_refund',
        cancelledAt: resolvedAt,
        dispute: { ...order.dispute, resolution },
      });
      if (!resolveRefundResult.ok) {
        throw new APIError(ErrorTypes.CONFLICT, 'Dispute was already resolved by another request', 409);
      }
      // エスクロー返金（存在すれば、ベストエフォート）
      try {
        const EscrowRepository = require('../../../db/json/EscrowRepository');
        const escrows = EscrowRepository.getByOrderId(order.id);
        if (Array.isArray(escrows) && escrows.length > 0) {
          const { createEscrowService } = require('../../../payments/escrow-service');
          const escrowSvc = createEscrowService();
          for (const e of escrows) {
            if (!['CANCELED', 'SETTLED'].includes(e.state)) {
              try { escrowSvc.cancel(e.id); } catch (err) { logger.warn(`Escrow cancel failed for ${e.id}: ${err.message}`); }
            }
          }
        }
      } catch (e) {
        logger.warn(`Escrow refund on dispute resolve failed (order=${order.id}): ${e.message}`);
      }
      // レピュテーション減点（実フローでの失敗反映）— ベストエフォート
      if (order.providerId) {
        try {
          const { createReputationService } = require('../../../reputation/reputation-service');
          const rep = createReputationService();
          rep.recordJobResult(order.providerId, false);
          rep.slash(order.providerId);
        } catch (e) {
          logger.warn(`reputation penalty on dispute refund failed (order=${order.id}): ${e.message}`);
        }
      }
      // 係争認容 = 申請者の主張は正当。申請者に「認容された係争」を加算する。
      // これにより申請者の「棄却率」が下がり、ゲート(#23の monotonic な永久バンを是正)から
      // 回復できる。正当な係争を多く起こす利用者を、数件の棄却で永久に締め出さない。
      const vRaiser = order.dispute && order.dispute.raisedBy;
      if (vRaiser) {
        try {
          const UserRepository = require('../../../db/json/UserRepository');
          const u = UserRepository.getById(vRaiser);
          if (u) {
            UserRepository.update(vRaiser, { vindicatedDisputeCount: (u.vindicatedDisputeCount || 0) + 1 });
          }
        } catch (e) {
          logger.warn(`vindicated-dispute accounting failed (raiser=${vRaiser}): ${e.message}`);
        }
      }
    } else {
      // uphold: 係争棄却。仕事は有効として completed へ。プロバイダに成功を記録。
      const resolveUpholdResult = OrderRepository.updateIf(order.id, (o) => o.status === 'disputed', {
        status: 'completed',
        stoppedAt: resolvedAt,
        dispute: { ...order.dispute, resolution },
      });
      if (!resolveUpholdResult.ok) {
        throw new APIError(ErrorTypes.CONFLICT, 'Dispute was already resolved by another request', 409);
      }
      // エスクロー精算（uphold = 仕事は有効 → HELD 資金をプロバイダへ解放）。
      // refund 側が escrowSvc.cancel で返金するのと対称に、uphold 側でも明示的に
      // SETTLED へ遷移させないと HELD のまま資金が永久ロックされ、プロバイダは
      // 正当に裁定勝ちしても入金されない（resolveUphold が status だけ completed に
      // して escrow を放置していた漏れの修正）。escrow の現状態に応じて正しい
      // イベント（HELD→DELIVER_OK / DISPUTED→RESOLVE_SETTLE）を選ぶ。
      try {
        const EscrowRepository = require('../../../db/json/EscrowRepository');
        const escrows = EscrowRepository.getByOrderId(order.id);
        if (Array.isArray(escrows) && escrows.length > 0) {
          const { createEscrowService } = require('../../../payments/escrow-service');
          const escrowSvc = createEscrowService();
          for (const e of escrows) {
            if (['SETTLED', 'CANCELED'].includes(e.state)) continue;
            const event = e.state === 'DISPUTED' ? 'RESOLVE_SETTLE'
              : e.state === 'HELD' ? 'DELIVER_OK'
              : null;
            if (!event) continue; // PENDING 等、まだ入金されていないものは精算対象外
            try {
              // 全量納品・SLA 満たしたものとして精算内訳を記録してから SETTLED へ遷移。
              escrowSvc.settle(e.id, { deliveredRatio: 1, slaUptimePct: 100 });
              escrowSvc.apply(e.id, event);
              logger.info(`Escrow ${e.id} settled (dispute uphold) for order ${order.id}`);
            } catch (err) {
              logger.warn(`Escrow settle on dispute uphold failed for ${e.id}: ${err.message}`);
            }
          }
        }
      } catch (e) {
        logger.warn(`Escrow settlement on dispute uphold failed (order=${order.id}): ${e.message}`);
      }
      if (order.providerId) {
        try {
          const { createReputationService } = require('../../../reputation/reputation-service');
          createReputationService().recordJobResult(order.providerId, true);
        } catch (e) {
          logger.warn(`reputation credit on dispute uphold failed (order=${order.id}): ${e.message}`);
        }
      }
      // 係争棄却 = 申請者の主張は不当。申請者(raisedBy)に「棄却された係争」を加算する。
      // 係争は active 注文を凍結しプロバイダの完了・支払・評判加点をブロックするため、
      // 無償の連続係争はグリーフィング(DoS)になる。申請者にコストを課して対称性を回復する。
      const raiser = order.dispute && order.dispute.raisedBy;
      if (raiser) {
        try {
          const UserRepository = require('../../../db/json/UserRepository');
          const u = UserRepository.getById(raiser);
          if (u) {
            UserRepository.update(raiser, { deniedDisputeCount: (u.deniedDisputeCount || 0) + 1 });
          }
        } catch (e) {
          logger.warn(`denied-dispute accounting failed (raiser=${raiser}): ${e.message}`);
        }
      }
    }

    // 両当事者へ裁定結果を通知
    const verdictText = decision === 'refund' ? '借り手への返金（プロバイダ過失）' : '係争棄却（注文は有効）';
    for (const uid of [order.userId, order.providerId]) {
      if (uid) {
        notifyUser(uid, 'order_dispute_resolved',
          `【Strawberry】注文 #${order.id} の係争が裁定されました。\n結果: ${verdictText}\nGPU: ${gpuName}${note ? `\n備考: ${note}` : ''}`,
          { subject: `【Strawberry】係争裁定: 注文 #${order.id}` });
      }
    }
    logger.info(`Dispute resolved for order: ${order.id}`, { orderId: order.id, decision, resolvedBy: req.user.id });
    invalidateUserCache(order.userId);
    if (order.providerId) invalidateUserCache(order.providerId);
    // 係争解決後はスラッシュ/成功が記録されるためレピュテーションキャッシュを即時無効化する
    invalidateRepCache(order.userId);
    if (order.providerId) invalidateRepCache(order.providerId);
    res.json({ message: 'Dispute resolved', orderId: order.id, resolution });
    }); // end withLock
  })
);

// 注文レビュー投稿（完了済み注文の借り手のみ、1 注文 1 回のみ）
// POST /orders/:id/review { rating: 1-5, comment?: string }
router.post('/:id/review',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const order = OrderRepository.getById(req.params.id);
    if (!order) throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    if (order.userId !== req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Only the order owner can submit a review', 403);
    }
    // 自己レビュー防止（多層防御）: 注文作成側で自己取引は弾くが、レガシー/管理者生成の
    // 自己注文が混入しても自分の GPU を自分で評価できないようにする。
    if (order.providerId && order.providerId === req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'You cannot review your own GPU', 403);
    }
    if (order.status !== 'completed') {
      throw new APIError(ErrorTypes.VALIDATION, 'Can only review completed orders', 400);
    }
    // 支払い未確認の注文へのレビューを禁止（係争後の裁定でcompletedになった無支払い注文への悪用防止）
    if (req.user.role !== 'admin') {
      const PaymentRepository = require('../../../db/json/PaymentRepository');
      const payments = PaymentRepository.getByOrderId(order.id) || [];
      const hasPaidPayment = payments.some(p => p.status === 'paid');
      if (!hasPaidPayment) {
        throw new APIError(ErrorTypes.FORBIDDEN, 'Cannot review an order without confirmed payment', 402);
      }
    }
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new APIError(ErrorTypes.VALIDATION, 'rating must be an integer between 1 and 5', 400);
    }
    const comment = req.body.comment ? sanitizeString(String(req.body.comment)).slice(0, 500) : '';
    const review = { rating, comment, reviewerId: req.user.id, reviewedAt: new Date().toISOString() };
    // Atomic check-and-write: re-reads the order inside the same synchronous section
    // to prevent a concurrent request that also passed the review=null check above
    // from overwriting the first writer's review.
    const reviewResult = OrderRepository.updateIf(order.id,
      o => o.status === 'completed' && !o.review,
      { review }
    );
    if (!reviewResult.ok) {
      throw new APIError(ErrorTypes.CONFLICT, 'This order already has a review', 409);
    }
    // プロバイダへレビュー通知
    if (order.providerId) {
      const { notifyUser } = require('../../../utils/user-notify');
      const gpu = GpuRepository.getById(order.gpuId);
      const gpuName = gpu ? gpu.name : order.gpuId;
      notifyUser(order.providerId, 'order_reviewed',
        `【Strawberry】あなたの GPU にレビューが投稿されました ★${rating}/5\nGPU: ${gpuName}\n注文: #${order.id}${comment ? `\nコメント: ${comment}` : ''}`,
        { subject: `【Strawberry】GPU「${gpuName}」にレビュー ★${rating}/5` });
    }
    // Invalidate GPU rating cache so the next GET /gpus/:id reflects the new review
    try {
      const GpuRoutes = require('../gpu/index');
      if (typeof GpuRoutes._invalidateGpuRatingCache === 'function') {
        GpuRoutes._invalidateGpuRatingCache(order.gpuId);
      }
    } catch (_) { /* best-effort */ }
    logger.info(`Review submitted for order: ${order.id}`, { orderId: order.id, rating });
    // レビュー投稿でプロバイダの平均評価が変わる → キャッシュ無効化
    if (order.providerId) invalidateRepCache(order.providerId);
    res.status(201).json({ message: 'Review submitted', review });
  })
);

// プロバイダ→借り手レビュー（完了済み注文の GPU プロバイダのみ、1 注文 1 回のみ）。
// 借り手→プロバイダ評価(#17)の対称: 難あり借り手（不払い・濫用・不当係争）を記録できる手段。
// POST /orders/:id/renter-review { rating: 1-5, comment?: string }
router.post('/:id/renter-review',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const order = OrderRepository.getById(req.params.id);
    if (!order) throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    if (!order.providerId) {
      throw new APIError(ErrorTypes.VALIDATION, 'Order has no provider recorded — renter review unavailable', 400);
    }
    if (order.providerId !== req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Only the GPU provider can review the renter', 403);
    }
    // 自己レビュー防止（多層防御）: 自己注文では借り手＝プロバイダのため評価不可
    if (order.userId === req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'You cannot review yourself', 403);
    }
    if (order.status !== 'completed') {
      throw new APIError(ErrorTypes.VALIDATION, 'Can only review completed orders', 400);
    }
    // 支払い未確認の注文へのレビューを禁止（係争後の裁定でcompletedになった無支払い注文への悪用防止）
    if (req.user.role !== 'admin') {
      const PaymentRepository = require('../../../db/json/PaymentRepository');
      const payments = PaymentRepository.getByOrderId(order.id) || [];
      const hasPaidPayment = payments.some(p => p.status === 'paid');
      if (!hasPaidPayment) {
        throw new APIError(ErrorTypes.FORBIDDEN, 'Cannot submit renter review for an order without confirmed payment', 402);
      }
    }
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new APIError(ErrorTypes.VALIDATION, 'rating must be an integer between 1 and 5', 400);
    }
    const comment = req.body.comment ? sanitizeString(String(req.body.comment)).slice(0, 500) : '';
    const renterReview = { rating, comment, reviewerId: req.user.id, reviewedAt: new Date().toISOString() };
    const renterReviewResult = OrderRepository.updateIf(order.id,
      o => o.status === 'completed' && !o.renterReview,
      { renterReview }
    );
    if (!renterReviewResult.ok) {
      throw new APIError(ErrorTypes.CONFLICT, 'This order already has a renter review', 409);
    }
    // 借り手へ通知
    const { notifyUser } = require('../../../utils/user-notify');
    notifyUser(order.userId, 'renter_reviewed',
      `【Strawberry】取引相手（プロバイダ）からあなたへの評価が投稿されました ★${rating}/5\n注文: #${order.id}${comment ? `\nコメント: ${comment}` : ''}`,
      { subject: `【Strawberry】あなたへの評価 ★${rating}/5（注文 #${order.id}）` });
    logger.info(`Renter review submitted for order: ${order.id}`, { orderId: order.id, rating, renterId: order.userId });
    // 借り手レビューが追加されると借り手の renterRatingAverage が変わる → キャッシュ無効化
    invalidateRepCache(order.userId);
    res.status(201).json({ message: 'Renter review submitted', review: renterReview });
  })
);

// マッチング要求 (認証必須)
router.post('/:id/match',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid().required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    logger.info(`Requesting matching for order: ${orderId}`);

    // ローカルリポジトリから取得（ソースオブトゥルース）
    const order = OrderRepository.getById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (req.user.role !== 'admin' && order.userId !== req.user.id) {
      return res.status(403).json({ error: 'You do not have permission to match this order' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ error: 'Order cannot be matched', details: `Current status: ${order.status}` });
    }

    // P2Pマッチングはネットワークサービスが必要
    if (!requireService(p2pNetwork, res)) return;
    const matchResult = await p2pNetwork.matchOrder(orderId);

    if (!matchResult || !matchResult.matched) {
      return res.json({ matched: false, message: 'No suitable GPU found for this order' });
    }

    // P2P ピアは信頼境界の外にいる。matchResult.gpu.providerId をそのまま採用すると、
    // 悪意あるピアが「実 GPU の ID + 被害者プロバイダの ID」を返して注文の providerId を
    // 被害者にすり替えられ、レピュテーション操作・払い出し先誤誘導につながる。
    // 必ずローカル GpuRepository の providerId を真とし、不一致なら 409 で拒否する。
    const matchedGpuId = matchResult.gpu && matchResult.gpu.id;
    const localGpu = matchedGpuId ? GpuRepository.getById(matchedGpuId) : null;
    if (!localGpu) {
      return res.status(409).json({ error: 'P2P match returned a GPU not present in the local registry' });
    }
    if (matchResult.gpu.providerId && localGpu.providerId !== matchResult.gpu.providerId) {
      logger.warn(`P2P providerId mismatch for GPU ${matchedGpuId}: local=${localGpu.providerId} peer=${matchResult.gpu.providerId}`);
      return res.status(409).json({ error: 'P2P match providerId conflicts with local GPU registry' });
    }

    const updateData = {
      status: 'matched',
      gpuId: matchedGpuId,
      providerId: localGpu.providerId,
      matchedAt: new Date().toISOString()
    };
    // Atomic write: guards against /accept or a second /match completing while
    // p2pNetwork.matchOrder() was awaiting above.
    const matchWriteResult = OrderRepository.updateIf(orderId, o => o.status === 'pending', updateData);
    if (!matchWriteResult.ok) {
      return res.status(409).json({ error: 'Order status changed while matching; match aborted', details: `Current status: ${(matchWriteResult.current || {}).status}` });
    }
    if (typeof p2pNetwork.updateOrder === 'function') {
      try { await p2pNetwork.updateOrder(orderId, updateData); } catch (_) {}
    }

    logger.info(`Order matched: ${orderId}`, { orderId, userId: req.user.id, gpuId: matchResult.gpu.id });
    res.json({ matched: true, message: 'Order successfully matched with GPU', matchResult });
  })
);

// オーダー実行開始 (認証必須)
// Joi は冒頭の validator から import 済み

router.post('/:id/start',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid().required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    logger.info(`Starting order execution: ${orderId}`);

    // Per-order mutex: prevents concurrent /start calls from both passing the
    // status check, double-allocating the GPU, and writing duplicate 'active' states.
    return withLock(`order:${orderId}`, async () => {
      const order = OrderRepository.getById(orderId);
      if (!order) {
        throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
      }
      if (req.user.role !== 'admin' && order.userId !== req.user.id) {
        throw new APIError(ErrorTypes.FORBIDDEN, 'You do not have permission to start this order', 403);
      }
      if (order.status !== 'matched') {
        return res.status(400).json({ error: 'Order cannot be started', details: `Current status: ${order.status}` });
      }

      // スケジュール開始時刻の検証: 5分の時計ズレ許容を設け、それより前の開始を拒否する。
      // これがないと、来週予定の注文を今すぐ起動でき、GPU プロバイダの合意時間枠を
      // 守らずに GPU を早期占有するスロット契約違反が起きる。
      if (req.user.role !== 'admin' && order.scheduledStartAt) {
        const schedMs = new Date(order.scheduledStartAt).getTime();
        const CLOCK_DRIFT_TOLERANCE_MS = 5 * 60 * 1000; // 5分
        if (!isNaN(schedMs) && Date.now() < schedMs - CLOCK_DRIFT_TOLERANCE_MS) {
          return res.status(400).json({
            error: `Order cannot be started before scheduled time`,
            scheduledStartAt: order.scheduledStartAt,
          });
        }
      }

      // 支払い確認: 無償で GPU を起動されないよう、確定済み支払いレコードを要求する。
      // 管理者は手動割り当て・テスト環境のために免除。
      if (req.user.role !== 'admin') {
        const PaymentRepository = require('../../../db/json/PaymentRepository');
        const payments = PaymentRepository.getByOrderId(order.id) || [];
        const hasPaidPayment = payments.some(p => p.status === 'paid');
        if (!hasPaidPayment) {
          throw new APIError(
            ErrorTypes.FORBIDDEN,
            'Cannot start order: no confirmed payment found. Complete the payment first.',
            402
          );
        }
      }

      // GPU割り当てには vgpuManager が必要
      if (!requireService(vgpuManager, res)) return;
      const allocation = await vgpuManager.allocateGPU(order.gpuId, orderId);
      if (!allocation || !allocation.success) {
        throw new APIError(ErrorTypes.INTERNAL, 'Failed to allocate GPU', 500, { details: allocation && allocation.message });
      }

      // Atomic compare-and-swap: only write if the order is still in 'matched' state.
      // Guards against a second concurrent request that passed the check above but
      // whose GPU allocation completed after ours.
      const updateData = { status: 'active', startedAt: new Date().toISOString(), allocationDetails: allocation };
      const result = OrderRepository.updateIf(orderId, o => o.status === 'matched', updateData);
      if (!result.ok) {
        // Another concurrent request already transitioned this order — release the GPU we just allocated.
        try { await vgpuManager.releaseGPU(order.gpuId, orderId); } catch (_) {}
        return res.status(409).json({ error: 'Order was already started by a concurrent request' });
      }
      if (p2pNetwork && typeof p2pNetwork.updateOrder === 'function') {
        try { await p2pNetwork.updateOrder(orderId, updateData); } catch (_) {}
      }
      // 借り手へ利用開始通知
      try {
        const { notifyUser } = require('../../../utils/user-notify');
        notifyUser(order.userId, 'order_started',
          `【Strawberry】GPU の利用が開始されました\n注文: #${orderId}`,
          { subject: `【Strawberry】注文 #${orderId} 利用開始` });
      } catch (_) { /* 通知失敗は起動を妨げない */ }

      res.json({ message: 'Order execution started successfully', allocationDetails: allocation });
    });
  })
);

// オーダー実行終了 (認証必須)
router.post('/:id/stop',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid().required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    logger.info(`Stopping order execution: ${orderId}`);

    // Per-order mutex: prevents concurrent /stop calls from both releasing the GPU,
    // double-recording reputation, and double-settling escrow for the same order.
    return withLock(`order:${orderId}`, async () => {
      const order = OrderRepository.getById(orderId);
      if (!order) {
        throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
      }
      // /stop は通常完了経路（status='completed', deliveredRatio→100%payout）。
      // プロバイダがこれを呼べると「accept→renter pay→renter start→provider 即 stop」で
      // 借り手の支払いを 0 秒の労働で全額受け取れる zero-work theft が成立する。
      // プロバイダが終了させたい場合は /dispute を使い admin 介在で settle/refund を決める。
      const canStop = req.user.role === 'admin'
        || order.userId === req.user.id;
      if (!canStop) {
        if (order.providerId && order.providerId === req.user.id) {
          throw new APIError(
            ErrorTypes.FORBIDDEN,
            'Provider cannot stop an active order; raise a dispute (POST /:id/dispute) for admin resolution.',
            403,
          );
        }
        throw new APIError(ErrorTypes.FORBIDDEN, 'You do not have permission to stop this order', 403);
      }
      if (order.status !== 'active') {
        throw new APIError(ErrorTypes.VALIDATION, 'Order cannot be stopped', 400, { details: `Current status: ${order.status}` });
      }

      // 支払い確認: active な注文は Lightning インボイス支払い済み、または管理者手動承認済みの
      // 決済レコードが存在するはずである。未払いのまま /stop を呼んで completed にされると
      // GPU 利用を無償で受け取り、レピュテーションも加点される。
      // 管理者は決済記録なしでも停止できる（手動割り当て・テスト環境等の例外処理に対応）。
      if (req.user.role !== 'admin') {
        const PaymentRepository = require('../../../db/json/PaymentRepository');
        const payments = PaymentRepository.getByOrderId(order.id) || [];
        const hasPaidPayment = payments.some(p => p.status === 'paid');
        if (!hasPaidPayment) {
          throw new APIError(
            ErrorTypes.FORBIDDEN,
            'Cannot stop order: no confirmed payment found. Complete the payment before stopping the order.',
            402
          );
        }
      }

      // GPU解放（vgpuManager が利用可能な場合のみ）
      let usageStats = null;
      if (vgpuManager) {
        try {
          await vgpuManager.releaseGPU(order.gpuId, orderId);
          usageStats = await vgpuManager.getGPUUsageStats(order.gpuId, orderId).catch(() => null);
        } catch (e) {
          logger.warn(`GPU release failed for order ${orderId}: ${e.message}`);
        }
      }

      // ハートビートセッションを削除（メモリリーク防止）。
      // heartbeatTimestamps の対応エントリも同時に除去（旧実装は usageSessions だけ
      // 削除し timestamps Map が無限増加していた）。
      usageSessions.delete(orderId);
      _deleteHeartbeatsForOrder(orderId);

      // Atomic compare-and-swap: only write completed if still active.
      // Reputation and escrow settlement only run when this write succeeds,
      // preventing double-increment if a second concurrent stop somehow slipped through.
      const updateData = { status: 'completed', stoppedAt: new Date().toISOString(), usageStats };
      const result = OrderRepository.updateIf(orderId, o => o.status === 'active', updateData);
      if (!result.ok) {
        return res.status(409).json({ error: 'Order was already stopped by a concurrent request' });
      }
      if (p2pNetwork && typeof p2pNetwork.updateOrder === 'function') {
        try { await p2pNetwork.updateOrder(orderId, updateData); } catch (_) {}
      }

      // プロバイダ・レピュテーションへ完了を記録（updateIf 成功時のみ: 二重記録を防ぐ）。
      if (order.providerId) {
        try {
          const { createReputationService } = require('../../../reputation/reputation-service');
          createReputationService().recordJobResult(order.providerId, true);
        } catch (e) {
          logger.warn(`reputation recordJobResult failed for order ${orderId}: ${e.message}`);
        }
      }

      // エスクロー自動解放（HELD → SETTLED）。支払済みエスクローがある場合に精算する。
      // 失敗してもオーダー完了は妨げない（エスクローはベストエフォート）。
      try {
        const EscrowRepository = require('../../../db/json/EscrowRepository');
        const { createEscrowService } = require('../../../payments/escrow-service');
        const escrowSvc = createEscrowService();
        const escrows = EscrowRepository.getByOrderId(orderId).filter(e => e.state === 'HELD');
        // 借り手停止時のフォールバック: usageStats が無い／0 秒のときに 100% 払い出しを
        // 既定にしていたが、計測欠落を借り手の不利益として全額決済するのは fail-open。
        // settlement-calculator 側の minChargeRatio が下限を担うため、ここでは
        // measured 値が無いときは 0 を渡し、計算器のポリシーで最低料金が適用される。
        for (const escrow of escrows) {
          const measured = usageStats && Number.isFinite(usageStats.usageSeconds) && order.durationMinutes
            ? Math.max(0, Math.min(1, usageStats.usageSeconds / (order.durationMinutes * 60)))
            : 0;
          escrowSvc.settle(escrow.id, { deliveredRatio: measured, slaUptimePct: 100 });
          escrowSvc.apply(escrow.id, 'DELIVER_OK');
          logger.info(`Escrow ${escrow.id} auto-released (DELIVER_OK) for order ${orderId}`);
        }
      } catch (e) {
        logger.warn(`Escrow auto-release failed for order ${orderId}: ${e.message}`);
      }

      // 借り手へ完了通知（支払い確認と利用時間サマリを含む）
      try {
        const { notifyUser } = require('../../../utils/user-notify');
        const duration = usageStats && usageStats.usageSeconds
          ? `${Math.round(usageStats.usageSeconds / 60)} 分` : `${order.durationMinutes} 分`;
        notifyUser(order.userId, 'order_completed',
          `【Strawberry】GPU 利用が完了しました\n注文: #${orderId}\n利用時間: ${duration}\nレビューを投稿して次回の GPU 選択に役立ててください。`,
          { subject: `【Strawberry】注文 #${orderId} 完了` });
      } catch (_) { /* 通知失敗は完了処理を妨げない */ }

      invalidateUserCache(order.userId);
      if (order.providerId) invalidateUserCache(order.providerId);
      res.json({ message: 'Order execution stopped successfully', usageStats });
    });
  })
);

// テスト用フック: セッション回収ロジックとセッションマップを公開する。
// （本番では 30 秒間隔の setInterval が reapUsageSessions を駆動する）
module.exports = router;
module.exports._usageSessions = usageSessions;
module.exports._reapUsageSessions = reapUsageSessions;
module.exports._OrderUsageSession = OrderUsageSession;
