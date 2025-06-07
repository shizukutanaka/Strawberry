// GPU障害時の自動停止・返金・補償フロー自動化モジュール
const { logger } = require('../utils/logger');
const { sendNotification, NotifyType } = require('../utils/notifier');
const { OrderRepository } = require('../db/json/OrderRepository');
const { PaymentRepository } = require('../db/json/PaymentRepository');

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
  let payment = PaymentRepository.getByOrderId(orderId);
  if (payment && payment.status === 'paid') {
    payment.status = 'refunded';
    payment.refundedAt = new Date().toISOString();
    PaymentRepository.update(payment.id, payment);
    logger.info(`[AUTO-RECOVERY] Payment ${payment.id} marked as refunded for order ${orderId}`);
    // TODO: 実際の返金処理（Lightning/銀行API等）は今後拡張
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
