// src/api/routes/order/index.js - オーダー関連APIルート
const express = require('express');
const router = express.Router();

// --- 利用時間セッション管理クラス ---
const usageSessions = new Map(); // orderId -> OrderUsageSession
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

// 全セッションのタイムアウト監視（30秒ごと）
// unref: テスト等でプロセス終了を妨げない（server.js の metricsInterval と同方針）
const sessionTimeoutInterval = setInterval(() => {
  for (const session of usageSessions.values()) {
    session.checkTimeouts();
  }
}, 30000);
if (sessionTimeoutInterval.unref) sessionTimeoutInterval.unref();

const { asyncHandler, APIError, ErrorTypes } = require('../../../utils/error-handler');
const { validateMiddleware, schemas, Joi } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole, allowOwnerOrAdmin } = require('../../middleware/security');

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
const { expireStaleOrders } = require('../../../utils/order-expiry');
// GPU を占有中とみなす注文ステータス（二重予約チェックに使用）
const BLOCKING_ORDER_STATUSES = new Set(['pending', 'matched', 'active']);

const { sanitizeObject } = require('../../../utils/sanitize');
const { cacheMiddleware } = require('../../middleware/cache');

// オーダー一覧取得 (認証必須)
// キャッシュは perUser 必須: URL のみをキーにすると先行ユーザーの注文一覧が
// 他ユーザーに返る（認可バイパス）ため、ユーザーIDをキーに含める。

router.get('/',
  cacheMiddleware({ perUser: true }),
  authenticateJWT,
  asyncHandler(async (req, res, next) => {
    try {
      logger.info('Fetching orders');
      // 期限切れ pending 注文を失効させてから一覧を返す（遅延スイープ）
      expireStaleOrders();
      let orders;
      if (req.user.role === 'admin') {
        orders = OrderRepository.getAll();
        // 管理者はユーザーIDやプロバイダIDで絞り込み可能（サポートワークフロー）
        if (req.query.userId) orders = orders.filter(o => o.userId === req.query.userId);
        if (req.query.providerId) orders = orders.filter(o => o.providerId === req.query.providerId);
      } else if (req.user.role === 'provider') {
        orders = OrderRepository.getAll().filter(o => o.providerId === req.user.id);
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
      const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
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
        ? Math.round((renterOrders.reduce((s, o) => s + o.renterReview.rating, 0) / renterReviewCount) * 10) / 10
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
    logger.info(`Updating order: ${order.id}`);
    // 入力値サニタイズ
    const sanitized = sanitizeObject(req.body, ['description']);
    // 状態遷移チェック
    if (sanitized.status && sanitized.status !== order.status) {
      if (!isValidOrderTransition(order.status, sanitized.status)) {
        return res.status(400).json({ error: `Invalid status transition from ${order.status} to ${sanitized.status}` });
      }
    }
    // オーダーを更新
    const prevStatus = order.status;
    const updatedOrder = OrderRepository.update(order.id, { ...order, ...sanitized });
    logger.info(`Order updated: ${order.id}`);
    // ステータスが matched または active に変わった場合は借り手へ通知
    if (sanitized.status && sanitized.status !== prevStatus) {
      try {
        const { notifyUser } = require('../../../utils/user-notify');
        if (sanitized.status === 'matched') {
          notifyUser(order.userId, 'order_matched',
            `【Strawberry】注文がマッチしました\n注文: #${order.id}\nまもなく利用を開始できます`,
            { subject: `【Strawberry】注文 #${order.id} マッチング完了` });
        } else if (sanitized.status === 'active') {
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
    // 借り手レーティングフロア: GPU に minRenterRating が設定されている場合、
    // 十分なレビュー実績を持つ借り手はその平均評価が floor を下回ると 422 で拒否される。
    // レビュー実績がない新規借り手は通過させる（初回拒絶ループ防止）。
    const renterOrders = OrderRepository.getAll().filter(o => o.userId === req.user.id && o.renterReview);
    const renterReviewCount = renterOrders.length;
    const renterRatingAverage = renterReviewCount > 0
      ? renterOrders.reduce((s, o) => s + o.renterReview.rating, 0) / renterReviewCount
      : null;
    if (gpu.minRenterRating && renterRatingAverage !== null && renterRatingAverage < gpu.minRenterRating) {
      throw new APIError(ErrorTypes.VALIDATION,
        `This GPU requires a minimum renter rating of ${gpu.minRenterRating} (your current rating: ${Math.round(renterRatingAverage * 10) / 10})`, 422);
    }
    // 二重予約チェック: 期限切れ pending を先に失効させ、時間帯の重複を確認する。
    // scheduledStartAt が指定された場合はカレンダー予約として時間帯重複を検査し、
    // 指定がない場合は即時予約として全 BLOCKING 注文と重複とみなす。
    expireStaleOrders();
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
    // 料金計算: GPUのpricePerHour必須
    let pricePerHour = gpu.pricePerHour;
    if (!pricePerHour || typeof pricePerHour !== 'number' || pricePerHour <= 0) {
      throw new APIError(ErrorTypes.VALIDATION, 'GPU pricePerHour must be a positive number', 400);
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
    const totalPrice = pricePer5Min * (durationMinutes / 5);
    // 冗長化為替APIで換算（キャッシュ活用）
    const { rate: satoshiToJPY } = await fetchRateInfo();
    const totalPriceJPY = Math.round(totalPrice * satoshiToJPY);
    // ファイル永続化リポジトリで作成
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
    const gpu = GpuRepository.getById(order.gpuId);
    const isProvider = gpu && gpu.providerId === req.user.id;
    if (req.user.role !== 'admin' && !isProvider) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Only the GPU provider or admin can reject an order', 403);
    }
    if (order.status !== 'pending') {
      throw new APIError(ErrorTypes.VALIDATION, `Cannot reject order in '${order.status}' state (only pending orders can be rejected)`, 400);
    }
    const cancelNote = req.body.reason ? String(req.body.reason).slice(0, 500) : '';
    OrderRepository.update(order.id, {
      status: 'cancelled',
      cancelReason: 'provider_rejected',
      cancelNote,
      cancelledAt: new Date().toISOString(),
    });
    // 借り手（レンター）へ通知
    const { notifyUser } = require('../../../utils/user-notify');
    const gpuName = gpu ? gpu.name : order.gpuId;
    notifyUser(order.userId, 'order_rejected',
      `【Strawberry】プロバイダがあなたの注文を拒否しました\n注文: #${order.id}\nGPU: ${gpuName}${cancelNote ? `\n理由: ${cancelNote}` : ''}`,
      { subject: `【Strawberry】注文 #${order.id} が拒否されました` });
    logger.info(`Order rejected by provider: ${order.id}`, { orderId: order.id, providerId: req.user.id, cancelNote });
    res.json({ message: 'Order rejected', orderId: order.id });
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
    }
    const reason = req.body.reason ? String(req.body.reason).slice(0, 1000) : '';
    const dispute = { raisedBy: req.user.id, reason, raisedAt: new Date().toISOString() };
    OrderRepository.update(order.id, { status: 'disputed', dispute });

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
    const order = OrderRepository.getById(req.params.id);
    if (!order) throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    if (order.status !== 'disputed') {
      throw new APIError(ErrorTypes.VALIDATION, `Only disputed orders can be resolved (current: '${order.status}')`, 400);
    }
    const decision = req.body.decision;
    if (!['refund', 'uphold'].includes(decision)) {
      throw new APIError(ErrorTypes.VALIDATION, "decision must be 'refund' or 'uphold'", 400);
    }
    const note = req.body.note ? String(req.body.note).slice(0, 1000) : '';
    const resolvedAt = new Date().toISOString();
    const resolution = { decision, note, resolvedBy: req.user.id, resolvedAt };

    const { notifyUser } = require('../../../utils/user-notify');
    const gpu = GpuRepository.getById(order.gpuId);
    const gpuName = gpu ? gpu.name : order.gpuId;

    if (decision === 'refund') {
      // 注文を終端へ（cancelled）。dispute オブジェクトに裁定結果を併記。
      OrderRepository.update(order.id, {
        status: 'cancelled',
        cancelReason: 'dispute_resolved_refund',
        cancelledAt: resolvedAt,
        dispute: { ...order.dispute, resolution },
      });
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
      OrderRepository.update(order.id, {
        status: 'completed',
        stoppedAt: resolvedAt,
        dispute: { ...order.dispute, resolution },
      });
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
    res.json({ message: 'Dispute resolved', orderId: order.id, resolution });
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
    if (order.review) {
      throw new APIError(ErrorTypes.CONFLICT, 'This order already has a review', 409);
    }
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new APIError(ErrorTypes.VALIDATION, 'rating must be an integer between 1 and 5', 400);
    }
    const comment = req.body.comment ? String(req.body.comment).slice(0, 500) : '';
    const review = { rating, comment, reviewerId: req.user.id, reviewedAt: new Date().toISOString() };
    OrderRepository.update(order.id, { review });
    // プロバイダへレビュー通知
    if (order.providerId) {
      const { notifyUser } = require('../../../utils/user-notify');
      const gpu = GpuRepository.getById(order.gpuId);
      const gpuName = gpu ? gpu.name : order.gpuId;
      notifyUser(order.providerId, 'order_reviewed',
        `【Strawberry】あなたの GPU にレビューが投稿されました ★${rating}/5\nGPU: ${gpuName}\n注文: #${order.id}${comment ? `\nコメント: ${comment}` : ''}`,
        { subject: `【Strawberry】GPU「${gpuName}」にレビュー ★${rating}/5` });
    }
    logger.info(`Review submitted for order: ${order.id}`, { orderId: order.id, rating });
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
    if (!order.providerId || order.providerId !== req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Only the GPU provider can review the renter', 403);
    }
    // 自己レビュー防止（多層防御）: 自己注文では借り手＝プロバイダのため評価不可
    if (order.userId === req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'You cannot review yourself', 403);
    }
    if (order.status !== 'completed') {
      throw new APIError(ErrorTypes.VALIDATION, 'Can only review completed orders', 400);
    }
    if (order.renterReview) {
      throw new APIError(ErrorTypes.CONFLICT, 'This order already has a renter review', 409);
    }
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new APIError(ErrorTypes.VALIDATION, 'rating must be an integer between 1 and 5', 400);
    }
    const comment = req.body.comment ? String(req.body.comment).slice(0, 500) : '';
    const renterReview = { rating, comment, reviewerId: req.user.id, reviewedAt: new Date().toISOString() };
    OrderRepository.update(order.id, { renterReview });
    // 借り手へ通知
    const { notifyUser } = require('../../../utils/user-notify');
    notifyUser(order.userId, 'renter_reviewed',
      `【Strawberry】取引相手（プロバイダ）からあなたへの評価が投稿されました ★${rating}/5\n注文: #${order.id}${comment ? `\nコメント: ${comment}` : ''}`,
      { subject: `【Strawberry】あなたへの評価 ★${rating}/5（注文 #${order.id}）` });
    logger.info(`Renter review submitted for order: ${order.id}`, { orderId: order.id, rating, renterId: order.userId });
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

    const updateData = {
      status: 'matched',
      gpuId: matchResult.gpu.id,
      providerId: matchResult.gpu.providerId,
      matchedAt: new Date().toISOString()
    };
    OrderRepository.update(orderId, { ...order, ...updateData });
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

    // ローカルリポジトリから取得（ソースオブトゥルース）
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

    // GPU割り当てには vgpuManager が必要
    if (!requireService(vgpuManager, res)) return;
    const allocation = await vgpuManager.allocateGPU(order.gpuId, orderId);
    if (!allocation || !allocation.success) {
      throw new APIError(ErrorTypes.INTERNAL, 'Failed to allocate GPU', 500, { details: allocation && allocation.message });
    }

    const updateData = { status: 'active', startedAt: new Date().toISOString(), allocationDetails: allocation };
    OrderRepository.update(orderId, { ...order, ...updateData });
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
  })
);

// オーダー実行終了 (認証必須)
router.post('/:id/stop',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid().required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    logger.info(`Stopping order execution: ${orderId}`);

    // ローカルリポジトリから取得（ソースオブトゥルース）
    const order = OrderRepository.getById(orderId);
    if (!order) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    }
    if (req.user.role !== 'admin' && order.userId !== req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'You do not have permission to stop this order', 403);
    }
    if (order.status !== 'active') {
      throw new APIError(ErrorTypes.VALIDATION, 'Order cannot be stopped', 400, { details: `Current status: ${order.status}` });
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

    // ハートビートセッションを削除（メモリリーク防止）
    usageSessions.delete(orderId);

    const updateData = { status: 'completed', stoppedAt: new Date().toISOString(), usageStats };
    OrderRepository.update(orderId, { ...order, ...updateData });
    if (p2pNetwork && typeof p2pNetwork.updateOrder === 'function') {
      try { await p2pNetwork.updateOrder(orderId, updateData); } catch (_) {}
    }

    // プロバイダ・レピュテーションへ完了を記録（マーケットの主要フロー→評判を接続）。
    // 失敗してもオーダー完了は妨げない（評判記録はベストエフォート）。
    if (order.providerId) {
      try {
        const { createReputationService } = require('../../../reputation/reputation-service');
        createReputationService().recordJobResult(order.providerId, true);
      } catch (e) {
        logger.warn(`reputation recordJobResult failed for order ${orderId}: ${e.message}`);
      }
    }

    res.json({ message: 'Order execution stopped successfully', usageStats });
  })
);

module.exports = router;
