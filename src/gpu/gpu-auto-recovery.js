// GPU障害時の自動停止・返金・補償フロー自動化モジュール
const { logger } = require('../utils/logger');
const { sendNotification, NotifyType } = require('../utils/notifier');
// これらのリポジトリはメソッド集合を直接 module.exports する（{ OrderRepository } で
// 分割代入すると undefined になり実行時クラッシュする）。デフォルト import で受ける。
const OrderRepository = require('../db/json/OrderRepository');
const PaymentRepository = require('../db/json/PaymentRepository');
const EscrowRepository = require('../db/json/EscrowRepository');
const { createEscrowService } = require('../payments/escrow-service');
const { appendAuditLog } = require('../utils/audit-log');

async function autoHandleGpuFailure(orderId, gpuId, userId, reason) {
  // 1. オーダー自動停止
  let order = OrderRepository.getById(orderId);
  if (order && order.status !== 'completed' && order.status !== 'failed') {
    order.status = 'failed';
    order.failedAt = new Date().toISOString();
    order.failureReason = reason;
    OrderRepository.update(orderId, order);
    logger.info(`[AUTO-RECOVERY] Order ${orderId} marked as failed due to GPU error: ${reason}`);
  }
  // 2. 返金処理（支払い済みの場合）
  // getByOrderId は many:true で配列を返すため、単体オブジェクトとして扱うバグを修正。
  const payments = PaymentRepository.getByOrderId(orderId) || [];
  for (const payment of payments) {
    if (payment.status === 'paid') {
      PaymentRepository.update(payment.id, { status: 'refunded', refundedAt: new Date().toISOString() });
      logger.info(`[AUTO-RECOVERY] Payment ${payment.id} marked as refunded for order ${orderId}`);
      // TODO: 実際の返金処理（Lightning/銀行API等）は今後拡張
    }
  }
  // 2b. エスクローの返金/解放: payment を refunded にしても escrow が HELD/PENDING の
  // ままだと資金がロックされたまま残る（未決済注文の自動失効とは別経路）。
  // プロバイダ起因の障害なので RESOLVE_REFUND（refund_renter + slash_provider）で精算し、
  // PENDING（未入金）は CANCEL で hold invoice を解放する。
  try {
    const escrowSvc = createEscrowService({ repository: EscrowRepository });
    const escrows = (EscrowRepository.getByOrderId && EscrowRepository.getByOrderId(orderId)) || [];
    for (const esc of escrows) {
      try {
        if (esc.state === 'DISPUTED') {
          escrowSvc.resolveDispute(esc.id, 'refund'); // refund_renter + slash_provider
          appendAuditLog('escrow_auto_refund_gpu_failure', { orderId, escrowId: esc.id, from: esc.state });
          logger.info(`[AUTO-RECOVERY] Escrow ${esc.id} refunded for order ${orderId}`);
        } else if (esc.state === 'HELD') {
          escrowSvc.cancel(esc.id); // cancel_invoice + refund_renter
          appendAuditLog('escrow_auto_refund_gpu_failure', { orderId, escrowId: esc.id, from: esc.state });
          logger.info(`[AUTO-RECOVERY] Held escrow ${esc.id} refunded for order ${orderId}`);
        } else if (esc.state === 'PENDING') {
          escrowSvc.cancel(esc.id);
          appendAuditLog('escrow_auto_cancel_gpu_failure', { orderId, escrowId: esc.id });
          logger.info(`[AUTO-RECOVERY] Pending escrow ${esc.id} cancelled for order ${orderId}`);
        }
      } catch (e) {
        logger.warn(`[AUTO-RECOVERY] Escrow ${esc.id} refund/cancel failed: ${e.message}`);
      }
    }
  } catch (e) {
    logger.warn(`[AUTO-RECOVERY] escrow refund wiring failed for order ${orderId}: ${e.message}`);
  }
  // 3. 多段通知
  const msg = `【GPU障害自動対応】\n注文: ${orderId}\nGPU: ${gpuId}\nユーザー: ${userId}\n理由: ${reason}\n\nオーダー停止・返金処理を自動実行しました。`;
  const channels = [
    process.env.LINE_TOKEN ? { type: NotifyType.LINE, opts: { token: process.env.LINE_TOKEN } } : null,
    process.env.DISCORD_WEBHOOK ? { type: NotifyType.DISCORD, opts: { webhookUrl: process.env.DISCORD_WEBHOOK } } : null,
    process.env.EMAIL_TO ? { type: NotifyType.EMAIL, opts: { to: process.env.EMAIL_TO, subject: '【Strawberry】GPU障害自動対応' } } : null
  ].filter(Boolean);
  for (const ch of channels) {
    try { await sendNotification(ch.type, msg, ch.opts); } catch(e) { logger.error('通知失敗', { channel: ch.type, error: e.message }); }
  }
}

module.exports = { autoHandleGpuFailure };
