// src/api/routes/order/mutations.js - 注文の作成・更新・削除・マッチング系エンドポイント
// （PUT/DELETE/POST・reject/accept — 状態遷移と escrow 連携を含む書き込み系）。
const express = require('express');
const router = express.Router();

const { asyncHandler, APIError, ErrorTypes } = require('../../../utils/error-handler');
const { validateMiddleware, schemas, Joi } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { appendAuditLog } = require('../../../utils/audit-log');
const { authenticateJWT, allowOwnerOrAdmin } = require('../../middleware/security');
const { withLock } = require('../../../utils/async-lock');
const OrderRepository = require('../../../db/json/OrderRepository');
const EscrowRepository = require('../../../db/json/EscrowRepository');
const { escrowService } = require('./escrow');
const GpuRepository = require('../../../db/json/GpuRepository');
const { notifyUser } = require('../../../utils/user-notify');
const { computeRenterRating, evaluateRenterEligibility } = require('../../../services/renter-eligibility');
const { fetchRateInfo, computeOrderPricing } = require('../../../utils/order-pricing');
const { sendNotification, NotifyType } = require('../../../utils/notifier');
const { isValidOrderTransition } = require('../../../utils/state-checker');
const { expireStaleOrders, expireStaleMatchedOrders } = require('../../../utils/order-expiry');
const { sanitizeObject, sanitizeString } = require('../../../utils/sanitize');
const { invalidateUserCache } = require('../../middleware/cache');
const { createSlidingWindowLimiter } = require('../../../utils/sliding-window-limit');

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

// 注文作成のユーザー別レートリミット（IP ベースのグローバル制限を補完）。
// 認証済みユーザーが在庫チェック・価格計算の重いパスを連打して DB を圧迫するのを防ぐ。
// グローバル IP リミットだけでは：同一ユーザーが異なる IP (Tor/VPN) から来た場合に効果がなく、
// また共有 IP (NAT) では無関係ユーザーを巻き込んでしまう。
// ここでは id ベースの滑動ウィンドウで「ユーザー単位」の短時間爆発を抑制する。
const ORDER_CREATE_RATE_LIMIT = Number(process.env.ORDER_CREATE_RATE_LIMIT) || 10;  // per window
const ORDER_CREATE_RATE_WINDOW_MS = 60_000; // 1 minute sliding window
const _orderCreateRateLimiter = createSlidingWindowLimiter({
  windowMs: ORDER_CREATE_RATE_WINDOW_MS,
  max: ORDER_CREATE_RATE_LIMIT,
});
function _checkOrderCreateRateLimit(userId) {
  return _orderCreateRateLimiter.hit(userId) <= ORDER_CREATE_RATE_LIMIT;
}
// 単体テストが Map を直接リセットできるよう公開（プロセス再起動が不要）
_checkOrderCreateRateLimit._state = _orderCreateRateLimiter.state;

router.put('/:id',
  authenticateJWT,
  validateMiddleware(schemas.idParam, 'params'),
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
      // 'completed' への直接遷移は POST /:id/stop のみが正規ルート。
      // admin PUT で active→completed させると escrow 精算・GPU 解放・評価記録が実行されず、
      // 資金が HELD のまま永久にロックされる（エスクロー不整合）。
      // admin は /stop を使うか、係争解決経由で completed に誘導すること。
      if (sanitized.status === 'completed') {
        throw new APIError(ErrorTypes.VALIDATION,
          "Use POST /:id/stop to complete an order. Setting status to 'completed' directly is not allowed.",
          400);
      }
    }
    // フィールドフィルタ: 明示的な許可リストのみ更新可能。
    // sanitizeObject は req.body の全キーをコピーする（文字列値のみサニタイズ）ため、
    // 許可リストなしで admin が sanitized をそのまま update() に渡すと
    // { totalPrice: 1, providerId: 'other', userId: 'victim' } 等の任意フィールドを
    // DB に書き込む mass-assignment 脆弱性になる。
    // 一般ユーザー: description/notes のみ。
    // 管理者: description/notes + status（status は上の isValidOrderTransition ゲート済み）。
    // 金融フィールド(totalPrice, pricePerHour)・所有権フィールド(userId, providerId, gpuId)は
    // いずれも変更不可（専用エンドポイントが担う）。
    const MUTABLE_BY_OWNER = new Set(['description', 'notes']);
    const MUTABLE_BY_ADMIN = new Set(['description', 'notes', 'status']);
    const updateData = req.user.role === 'admin'
      ? Object.fromEntries(Object.entries(sanitized).filter(([k]) => MUTABLE_BY_ADMIN.has(k)))
      : Object.fromEntries(Object.entries(sanitized).filter(([k]) => MUTABLE_BY_OWNER.has(k)));
    // admin が PUT で status を 'cancelled' にする場合、エスクローを先にキャンセルする。
    // これが無いと HELD 資金が永久にロックされ借り手は返金を受けられない（escrow 不整合）。
    // HELD エスクローのキャンセル失敗は致命的: 注文更新を中断してエラーを返す。
    if (updateData.status === 'cancelled') {
      try {
          const escrows = EscrowRepository.getByOrderId(order.id) || [];
        if (escrows.length > 0) {
            const escrowSvc = escrowService();
          for (const escrow of escrows) {
            if (['CANCELED', 'SETTLED'].includes(escrow.state)) continue;
            // HELD escrow cancel failure must not be silently swallowed — propagate it.
            escrowSvc.cancel(escrow.id);
          }
        }
      } catch (e) {
        throw new APIError(ErrorTypes.INTERNAL,
          `Cannot cancel order: escrow cancellation failed (${e.message}). Retry or resolve escrow manually.`,
          502);
      }
    }
    // オーダーを更新（update() は内部で merge するため delta のみ渡す。
    // 旧コードの { ...order, ...sanitized } は getById〜update 間の並行書き込みを上書きする
    // stale-spread anti-pattern だった）
    const prevStatus = order.status;
    const updatedOrder = OrderRepository.update(order.id, updateData);
    logger.info(`Order updated: ${order.id}`);
    invalidateUserCache(req.user.id);
    if (order.providerId && order.providerId !== req.user.id) invalidateUserCache(order.providerId);
    // Admin status overrides must be audit-logged with the acting admin's ID.
    // Without this, a malicious or compromised admin can silently alter order states
    // (e.g., cancel a disputed order to deny a renter's refund) with no tamper-evident record.
    if (updateData.status && updateData.status !== prevStatus && req.user.role === 'admin') {
      appendAuditLog('admin_order_status_override', {
        orderId: order.id,
        previousStatus: prevStatus,
        newStatus: updateData.status,
        adminId: req.user.id,
        orderUserId: order.userId,
        orderProviderId: order.providerId,
      }, req.user.id);
    }
    // ステータスが matched または active に変わった場合は借り手へ通知
    if (updateData.status && updateData.status !== prevStatus) {
      try {
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
  validateMiddleware(schemas.idParam, 'params'),
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
    // 注文単位の mutex: 並行するキャンセルリクエストが escrowSvc.cancel() を
    // 二重呼出しする前に updateIf CAS が実行されるよう直列化する。
    return withLock(`order:${order.id}:cancel`, async () => {
    // 状態チェック（ロック内で再読み込みして最新状態を確認）
    const freshOrder = OrderRepository.getById(order.id);
    if (!freshOrder || !['pending', 'matched'].includes(freshOrder.status)) {
      throw new APIError(ErrorTypes.VALIDATION, 'Only pending or matched orders can be deleted', 400);
    }
    // エスクローが存在する場合は返金キャンセルを試みる。
    // HELD エスクロー（入金済）のキャンセル失敗は致命的: 注文をキャンセル状態にすると
    // 資金が HELD のまま永久にロックされるため、失敗時は注文キャンセルを中断してエラーを返す。
    // PENDING エスクローは未入金なので失敗しても資金喪失はなく、ベストエフォートで扱う。
    try {
      const escrows = EscrowRepository.getByOrderId(order.id);
      if (Array.isArray(escrows) && escrows.length > 0) {
        const escrowSvc = escrowService();
        for (const escrow of escrows) {
          if (['CANCELED', 'SETTLED'].includes(escrow.state)) continue;
          if (escrow.state === 'HELD') {
            // HELD escrow cancel failure must block the delete — do NOT swallow.
            escrowSvc.cancel(escrow.id);
          } else {
            // PENDING/DISPUTED: best-effort cancel; failure is logged but non-blocking.
            try { escrowSvc.cancel(escrow.id); } catch (e) {
              logger.warn(`Non-critical escrow cancel failed for ${escrow.id} (${escrow.state}): ${e.message}`);
            }
          }
        }
      }
    } catch (e) {
      if (e.name === 'APIError') throw e;
      // Escrow lookup failure or HELD cancel failure — block the order cancellation.
      throw new APIError(ErrorTypes.INTERNAL,
        `Cannot cancel order: escrow operation failed (${e.message}). Retry or contact support.`,
        502);
    }
    // ハード削除ではなくソフトキャンセル（audit trail / 係争 / 統計を保全）。
    // updateIf で CAS を使う: 並行する /accept が pending→matched へ遷移させた後に
    // DELETE の status=pending 確認（req.resource は snapshot）が通過し、
    // 盲目的な update() が matched を上書きキャンセルするのを防ぐ。
    const cancelResult = OrderRepository.updateIf(
      order.id,
      (o) => ['pending', 'matched'].includes(o.status),
      {
        status: 'cancelled',
        cancelReason: 'user_cancelled',
        cancelledAt: new Date().toISOString(),
      }
    );
    if (!cancelResult.ok) {
      throw new APIError(
        ErrorTypes.CONFLICT,
        `Order status changed concurrently (now '${cancelResult.current?.status}'). Only pending or matched orders can be cancelled.`,
        409
      );
    }
    // プロバイダへキャンセル通知（予約した GPU が開放されたことを即時連絡）
    if (order.providerId) {
      try {
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
    }); // end withLock(cancel)
  })
);

// オーダー作成 (認証必須)
router.post('/', 
  authenticateJWT,
  validateMiddleware(schemas.order.create),
  asyncHandler(async (req, res) => {
    // ユーザー別レートリミット（IP ベースグローバル制限の補完）
    if (!_checkOrderCreateRateLimit(req.user.id)) {
      throw new APIError(ErrorTypes.CONFLICT,
        `Too many order creation requests. Limit: ${ORDER_CREATE_RATE_LIMIT} per minute per user.`, 429);
    }
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
    // これを許すと、注文→完了で稼働実績を、自己レビューで GPU 評価を、
    // いずれも無から捏造できてしまう（信頼層の偽造）。
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
    // 借り手レーティング資格チェック: ルールは renter-eligibility に集約（注文作成と
    // GET /gpus/:id/eligibility 事前チェックで同一ロジックを共有し、ドリフトを防ぐ）。
    //
    // 新規（レビュー実績ゼロ）の借り手の扱いには設計上のトレードオフがある:
    //   - 厳格: 新規=評価0 とみなし floor>0 の GPU を一律拒否 → Sybil（捨てアカウントで
    //     低評価を回避）に強いが、正当な新規借り手の参入を全プロバイダが阻害でき、
    //     二面市場のオンボーディングを殺す。
    //   - 寛容（既定）: 新規は「未評価」として通し、プロバイダの accept ゲートで判断させる。
    //     注文作成は pending を生むだけでプロバイダの明示承認が必要なため、Sybil の実害は
    //     accept 時点で抑止できる。
    // 既定は寛容とし、Sybil 耐性を必須としたいプロバイダは gpu.rejectUnratedRenters:true で
    // 明示的にオプトインできる（未評価の借り手も floor 扱いで拒否）。
    // minRenterRating を設定しない GPU（undefined/0/null）は全借り手を受け付ける。
    const _allOrdersForRating = OrderRepository.getAll();
    const renterRating = computeRenterRating(_allOrdersForRating, req.user.id);
    const renterRatingAverage = renterRating.average; // 通知メッセージで使用
    const renterReviewCount = renterRating.count;
    // self_trade は上で専用メッセージ済みなので、ここではレーティング系の判定のみ強制する。
    const _elig = evaluateRenterEligibility(gpu, req.user.id, renterRating);
    if (!_elig.eligible && (_elig.reason === 'no_rating_history' || _elig.reason === 'below_rating_floor')) {
      throw new APIError(ErrorTypes.VALIDATION, _elig.message, 422);
    }
    // 料金計算: GPUのpricePerHour必須
    let pricePerHour = gpu.pricePerHour;
    if (!pricePerHour || typeof pricePerHour !== 'number' || pricePerHour <= 0) {
      throw new APIError(ErrorTypes.VALIDATION, 'GPU pricePerHour must be a positive number', 400);
    }

    // 為替レートを先にフェッチ（キャッシュ活用）。以下の全チェックと create() は
    // 同期的に実行される（await なし）ため、この await の後に事前予約/二重予約の
    // TOCTOU レースウィンドウが生じない。洪水上限超過時は若干余分なキャッシュ参照が
    // 発生するが、fetchRateInfo はほぼ常にキャッシュヒットするため許容範囲。
    // fetchRateInfo().rate は「1 BTC あたりの JPY」（getBTCtoJPYRate の単位）。
    // 変数名 satoshiToJPY は誤解を招く（実体は BTC あたりのレート）— sat→JPY 換算は
    // totalPrice(sat) を 1e8 で割って BTC に変換してから乗じる必要がある（下記参照）。
    const { rate: btcToJPY } = await fetchRateInfo();

    // 洪水防止: 2 段階チェック（単一 getAll() で両チェックを完結させ余分な I/O を避ける）。
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

    // 二重予約チェック: 期限切れ pending を先に失効させ、時間帯の重複を確認する。
    // scheduledStartAt が指定された場合はカレンダー予約として時間帯重複を検査し、
    // 指定がない場合は即時予約として全 BLOCKING 注文と重複とみなす。
    // このブロックは同期的（await なし）— fetchRateInfo() が上で済んでいるため
    // ここから OrderRepository.create() までイベントループの yield は発生しない。
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
    // totalPrice は satoshi、btcToJPY は BTC あたりのレートなので、1e8 で割って
    // BTC に変換してから乗じる（そのまま掛けると 1e8 倍に水増しされる単位不一致バグ）。
    const rawJPY = Math.round((totalPrice / 1e8) * btcToJPY);
    const totalPriceJPY = Number.isFinite(rawJPY) ? rawJPY : null;
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
    // 環境変数から通知先を取得（例: LINE_TOKEN, DISCORD_WEBHOOK, SLACK_WEBHOOK_URL, GENERIC_WEBHOOK）
    if (process.env.LINE_TOKEN) {
      sendNotification(NotifyType.LINE, notifyMsg, { token: process.env.LINE_TOKEN }).catch(() => {});
    }
    if (process.env.DISCORD_WEBHOOK) {
      sendNotification(NotifyType.DISCORD, notifyMsg, { webhookUrl: process.env.DISCORD_WEBHOOK }).catch(() => {});
    }
    if (process.env.SLACK_WEBHOOK_URL) {
      sendNotification(NotifyType.SLACK, notifyMsg, { webhookUrl: process.env.SLACK_WEBHOOK_URL }).catch(() => {});
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
  validateMiddleware(schemas.idParam, 'params'),
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
      const escrows = EscrowRepository.getByOrderId(order.id);
      if (Array.isArray(escrows) && escrows.length > 0) {
        const escrowSvc = escrowService();
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
  validateMiddleware(schemas.idParam, 'params'),
  asyncHandler(async (req, res) => {
    const order = OrderRepository.getById(req.params.id);
    if (!order) throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);

    // order.providerId は注文作成時に確定させる（注文作成後の GPU 乗っ取り防止）。
    const isProvider = order.providerId && order.providerId === req.user.id;
    if (req.user.role !== 'admin' && !isProvider) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Only the GPU provider or admin can accept an order', 403);
    }
    if (order.status !== 'pending') {
      throw new APIError(ErrorTypes.VALIDATION, `Cannot accept order in '${order.status}' state (only pending orders can be accepted)`, 400);
    }
    const gpu = GpuRepository.getById(order.gpuId);
    // GPU ownership re-check: if an admin reassigned this GPU after the order was
    // created, the ex-provider's order.providerId still matches but they no longer
    // own the GPU. Block accept until an admin resolves the ownership conflict.
    if (req.user.role !== 'admin' && gpu && gpu.providerId !== req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'GPU ownership has changed since this order was created; contact an admin to resolve', 403);
    }
    const now = new Date().toISOString();
    // TOCTOU防止: accept と reject/DELETE が同時実行、または accept-ownership-check と
    // GPU 所有権移転が競合した場合にどちらか一方のみ通過させる。
    // GPU 所有権を updateIf 述語の中で再確認し、チェック→書込みの間に admin が
    // GPU を他プロバイダへ移管した場合でも旧プロバイダの accept が通らないようにする。
    const acceptingUserId = req.user.id;
    const acceptResult = OrderRepository.updateIf(order.id,
      (o) => o.status === 'pending' &&
        (req.user.role === 'admin' || (() => {
          const freshGpu = GpuRepository.getById(o.gpuId);
          return freshGpu && freshGpu.providerId === acceptingUserId;
        })()),
      { status: 'matched', matchedAt: now, updatedAt: now }
    );
    // updateIf は常にオブジェクト({ok, row} or {ok:false, reason, current})を返す。
    // !acceptResult は決して true にならないため CAS 失敗時に renter に "accepted" 通知が
    // 飛び、reject 側で cancelled になっているのに matched と返してしまう不整合が出ていた。
    if (!acceptResult.ok) {
      throw new APIError(ErrorTypes.CONFLICT, 'Order status changed before accept could complete; please retry', 409);
    }
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
module.exports = router;
module.exports._checkOrderCreateRateLimit = _checkOrderCreateRateLimit;
