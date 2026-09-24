// src/api/routes/order/disputes.js - オーダー紛争系エンドポイント
// （dispute 提起・管理者裁定・双方レビュー）。
const express = require('express');
const router = express.Router();

const { asyncHandler, APIError, ErrorTypes } = require('../../../utils/error-handler');
const { validateMiddleware, schemas, Joi } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');
const { withLock } = require('../../../utils/async-lock');
const OrderRepository = require('../../../db/json/OrderRepository');
const EscrowRepository = require('../../../db/json/EscrowRepository');
const { escrowService } = require('./escrow');
const GpuRepository = require('../../../db/json/GpuRepository');
const PaymentRepository = require('../../../db/json/PaymentRepository');
const UserRepository = require('../../../db/json/UserRepository');
const { notifyUser } = require('../../../utils/user-notify');
const GpuRoutes = require('../gpu/index');
const { sanitizeString } = require('../../../utils/sanitize');
const { invalidateUserCache } = require('../../middleware/cache');

router.post('/:id/dispute',
  authenticateJWT,
  validateMiddleware(schemas.idParam, 'params'),
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
    // 注文単位の mutex: renter と provider が同時に同じ注文へ係争を申請した場合に
    // 相互排除する（per-user key では異なるユーザー間で serialization されない）。
    // per-user open-disputes カウントは内側でチェックするため保護される。
    return withLock(`order:${order.id}:dispute`, async () => {
      if (req.user.role !== 'admin') {
        const MIN_RESOLVED = Number(process.env.MIN_RESOLVED_DISPUTES) || 3;
        const MAX_DENIED_RATE = Number(process.env.MAX_DENIED_DISPUTE_RATE) || 0.67;
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
    });
  })
);

// 係争の裁定（管理者のみ）— 宙ぶらりんの disputed 注文を終端状態へ遷移させる。
// POST /orders/:id/dispute/resolve { decision: 'refund'|'uphold', note?: string }
//  - refund: 借り手勝訴（プロバイダ過失）→ 注文を cancelled、エスクロー返金。
//  - uphold: 係争棄却（プロバイダ正当）→ 注文を completed。

router.post('/:id/dispute/resolve',
  authenticateJWT,
  checkRole(['admin']),
  validateMiddleware(schemas.idParam, 'params'),
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    // 二重裁定の副作用（escrow 精算・raiser counter の二重加算など）
    // を防ぐため、order 単位の mutex で全フローを直列化する。CAS だけだと CAS 前の副作用
    // （raiser の getById+update）が並行に走り得る。
    // ロックキーを `order:${orderId}` に統一: /start・/stop と同一 mutex を共有することで、
    // /stop の vgpuManager.releaseGPU() が進行中に dispute/resolve が escrow 精算を
    // 並行実行し GPU が二重解放・二重精算されるリスクを排除する（旧: dispute-resolve
    // キーが /start・/stop と別 namespace で完全な排他になっていなかった）。
    return withLock(`order:${orderId}`, async () => {
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
          const escrows = EscrowRepository.getByOrderId(order.id);
        if (Array.isArray(escrows) && escrows.length > 0) {
            const escrowSvc = escrowService();
          for (const e of escrows) {
            if (!['CANCELED', 'SETTLED'].includes(e.state)) {
              try { escrowSvc.cancel(e.id); } catch (err) { logger.warn(`Escrow cancel failed for ${e.id}: ${err.message}`); }
            }
          }
        }
      } catch (e) {
        logger.warn(`Escrow refund on dispute resolve failed (order=${order.id}): ${e.message}`);
      }
      // 係争認容 = 申請者の主張は正当。申請者に「認容された係争」を加算する。
      // これにより申請者の「棄却率」が下がり、ゲート(#23の monotonic な永久バンを是正)から
      // 回復できる。正当な係争を多く起こす利用者を、数件の棄却で永久に締め出さない。
      const vRaiser = order.dispute && order.dispute.raisedBy;
      if (vRaiser) {
        try {
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
        completedAt: resolvedAt,
        dispute: { ...order.dispute, resolution },
      });
      if (!resolveUpholdResult.ok) {
        throw new APIError(ErrorTypes.CONFLICT, 'Dispute was already resolved by another request', 409);
      }
      // エスクロー精算（uphold = 仕事は有効 → HELD 資金をプロバイダへ解放）。
      // refund 側が escrowSvc.cancel で返金するのと対称に、uphold 側でも明示的に
      // SETTLED へ遷移させないと HELD のまま資金が永久ロックされ、プロバイダは
      // 正当に裁定勝ちしても入金されない。escrow の現状態に応じて正しい
      // イベント（HELD→DELIVER_OK / DISPUTED→RESOLVE_SETTLE）を選ぶ。
      try {
          const escrows = EscrowRepository.getByOrderId(order.id);
        if (Array.isArray(escrows) && escrows.length > 0) {
            const escrowSvc = escrowService();
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
      // 係争棄却 = 申請者の主張は不当。申請者(raisedBy)に「棄却された係争」を加算する。
      // 係争は active 注文を凍結しプロバイダの完了・支払・評判加点をブロックするため、
      // 無償の連続係争はグリーフィング(DoS)になる。申請者にコストを課して対称性を回復する。
      const raiser = order.dispute && order.dispute.raisedBy;
      if (raiser) {
        try {
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
    if (order.providerId)    res.json({ message: 'Dispute resolved', orderId: order.id, resolution });
    }); // end withLock
  })
);

// 注文レビュー投稿（完了済み注文の借り手のみ、1 注文 1 回のみ）
// POST /orders/:id/review { rating: 1-5, comment?: string }

router.post('/:id/review',
  authenticateJWT,
  validateMiddleware(schemas.idParam, 'params'),
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
    // レビュー期限: 完了から 30 日以内のみ受け付ける（完了後の嫌がらせ・サクラ投稿を抑止）
    // completedAt がない旧レコード（stoppedAt のみ）にも対応する多層防御フォールバック
    const reviewWindowAnchor = order.completedAt || order.stoppedAt;
    if (reviewWindowAnchor) {
      const daysSinceCompletion = (Date.now() - new Date(reviewWindowAnchor).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceCompletion > 30) {
        throw new APIError(ErrorTypes.VALIDATION, 'Reviews must be submitted within 30 days of order completion', 400);
      }
    }
    // 支払い未確認の注文へのレビューを禁止（係争後の裁定でcompletedになった無支払い注文への悪用防止）
    if (req.user.role !== 'admin') {
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
      const gpu = GpuRepository.getById(order.gpuId);
      const gpuName = gpu ? gpu.name : order.gpuId;
      notifyUser(order.providerId, 'order_reviewed',
        `【Strawberry】あなたの GPU にレビューが投稿されました ★${rating}/5\nGPU: ${gpuName}\n注文: #${order.id}${comment ? `\nコメント: ${comment}` : ''}`,
        { subject: `【Strawberry】GPU「${gpuName}」にレビュー ★${rating}/5` });
    }
    // Invalidate GPU rating cache so the next GET /gpus/:id reflects the new review
    try {
      if (typeof GpuRoutes._invalidateGpuRatingCache === 'function') {
        GpuRoutes._invalidateGpuRatingCache(order.gpuId);
      }
    } catch (_) { /* best-effort */ }
    logger.info(`Review submitted for order: ${order.id}`, { orderId: order.id, rating });
    // レビュー投稿でプロバイダの平均評価が変わる → キャッシュ無効化
    if (order.providerId)    res.status(201).json({ message: 'Review submitted', review });
  })
);

// プロバイダ→借り手レビュー（完了済み注文の GPU プロバイダのみ、1 注文 1 回のみ）。
// 借り手→プロバイダ評価(#17)の対称: 難あり借り手（不払い・濫用・不当係争）を記録できる手段。
// POST /orders/:id/renter-review { rating: 1-5, comment?: string }

router.post('/:id/renter-review',
  authenticateJWT,
  validateMiddleware(schemas.idParam, 'params'),
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
    // レビュー期限: 完了から 30 日以内のみ受け付ける（完了後の嫌がらせ・サクラ投稿を抑止）
    // completedAt がない旧レコード（stoppedAt のみ）にも対応する多層防御フォールバック
    const renterReviewWindowAnchor = order.completedAt || order.stoppedAt;
    if (renterReviewWindowAnchor) {
      const daysSinceCompletion = (Date.now() - new Date(renterReviewWindowAnchor).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceCompletion > 30) {
        throw new APIError(ErrorTypes.VALIDATION, 'Renter reviews must be submitted within 30 days of order completion', 400);
      }
    }
    // 支払い未確認の注文へのレビューを禁止（係争後の裁定でcompletedになった無支払い注文への悪用防止）
    if (req.user.role !== 'admin') {
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
    notifyUser(order.userId, 'renter_reviewed',
      `【Strawberry】取引相手（プロバイダ）からあなたへの評価が投稿されました ★${rating}/5\n注文: #${order.id}${comment ? `\nコメント: ${comment}` : ''}`,
      { subject: `【Strawberry】あなたへの評価 ★${rating}/5（注文 #${order.id}）` });
    logger.info(`Renter review submitted for order: ${order.id}`, { orderId: order.id, rating, renterId: order.userId });
    // 借り手レビューが追加されると借り手の renterRatingAverage が変わる → キャッシュ無効化
    res.status(201).json({ message: 'Renter review submitted', review: renterReview });
  })
);

// オーダー実行開始 (認証必須)
// Joi は冒頭の validator から import 済み


module.exports = router;
