// src/api/routes/order/runtime.js - オーダー実行系エンドポイント
// （ハートビート受付・レンタル開始・停止/精算）。セッション状態は ./sessions と共有。
const express = require('express');
const router = express.Router();

const { usageSessions, heartbeatTimestamps, OrderUsageSession, reapUsageSessions, _deleteHeartbeatsForOrder } = require('./sessions');
const { asyncHandler, APIError, ErrorTypes } = require('../../../utils/error-handler');
const { validateMiddleware, Joi } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT } = require('../../middleware/security');
const { withLock } = require('../../../utils/async-lock');
const { vgpuManager, requireService } = require('../../../core/services');
const OrderRepository = require('../../../db/json/OrderRepository');
const EscrowRepository = require('../../../db/json/EscrowRepository');
const { escrowService } = require('./escrow');
const GpuRepository = require('../../../db/json/GpuRepository');
const PaymentRepository = require('../../../db/json/PaymentRepository');
const { notifyUser } = require('../../../utils/user-notify');
const providerUptime = require('../../../reputation/provider-uptime');
const { invalidateUserCache } = require('../../middleware/cache');

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
    // プロバイダー（lender）ハートビートは稼働実績として永続化し、信頼性スコアの母数にする。
    // best-effort（失敗してもハートビート応答は返す）。
    if (role === 'lender') {
      providerUptime.recordProviderHeartbeat(order.providerId, orderId, nowMs);
    }
    res.json({ usageSeconds: session.getUsageSeconds() });
  })
);

// オーダー詳細取得 (認証必須)

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
      // vgpuManager.virtualGPUs は物理検出（nvidia-smi 等）を経た GPU のみを保持する。
      // marketplace 経由で登録された GPU（他プロバイダのマシン上に実在する GPU を含む）は
      // このノードのローカル検出には現れないため、allocateGPU は常に
      // "Virtual GPU not found" で失敗していた。GPU レコードを渡し、未登録なら
      // marketplace のスペックから最小限のエントリを遅延登録させる。
      const gpu = GpuRepository.getById(order.gpuId);
      const allocation = await vgpuManager.allocateGPU(order.gpuId, orderId, gpu);
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
      // 借り手へ利用開始通知
      try {
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

    // Per-order mutex: prevents concurrent /stop calls from both releasing the GPU
    // and double-settling escrow for the same order.
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
      // heartbeatTimestamps の対応エントリも同時に除去しないと timestamps Map が
      // 無限増加する。
      usageSessions.delete(orderId);
      _deleteHeartbeatsForOrder(orderId);

      // Atomic compare-and-swap: only write completed if still active.
      // Escrow settlement only runs when this write succeeds,
      // preventing double-settlement if a second concurrent stop somehow slipped through.
      const now43g = new Date().toISOString();
      const updateData = { status: 'completed', stoppedAt: now43g, completedAt: now43g, usageStats };
      const result = OrderRepository.updateIf(orderId, o => o.status === 'active', updateData);
      if (!result.ok) {
        return res.status(409).json({ error: 'Order was already stopped by a concurrent request' });
      }

      // エスクロー自動解放（HELD → SETTLED）。支払済みエスクローがある場合に精算する。
      // 失敗してもオーダー完了は妨げない（エスクローはベストエフォート）。
      try {
          const escrowSvc = escrowService();
        const escrows = EscrowRepository.getByOrderId(orderId).filter(e => e.state === 'HELD');
        // 借り手停止時のフォールバック: usageStats が無い／0 秒のときに 100% 払い出しを
        // 既定にしていたが、計測欠落を借り手の不利益として全額決済するのは fail-open。
        // settlement-calculator 側の minChargeRatio が下限を担うため、ここでは
        // measured 値が無いときは 0 を渡し、計算器のポリシーで最低料金が適用される。
        // Fallback delivered ratio: when vgpuManager is absent (no usageStats),
        // use wall-clock elapsed time rather than 0. Without this a renter could
        // call /start then /stop immediately, receive measured=0, and pay near
        // nothing if the minChargeRatio floor is below 1.0.
        const elapsedSeconds = order.startedAt
          ? Math.max(0, (Date.now() - new Date(order.startedAt).getTime()) / 1000)
          : 0;
        for (const escrow of escrows) {
          const measured = usageStats && Number.isFinite(usageStats.usageSeconds) && order.durationMinutes
            ? Math.max(0, Math.min(1, usageStats.usageSeconds / (order.durationMinutes * 60)))
            : order.durationMinutes
              ? Math.max(0, Math.min(1, elapsedSeconds / (order.durationMinutes * 60)))
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
