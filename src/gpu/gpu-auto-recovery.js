// GPU障害時の自動停止・通知フロー自動化モジュール
const { logger } = require('../utils/logger');
const { sendNotification, NotifyType } = require('../utils/notifier');
// このリポジトリはメソッド集合を直接 module.exports する（{ OrderRepository } で
// 分割代入すると undefined になり実行時クラッシュする）。デフォルト import で受ける。
const OrderRepository = require('../db/json/OrderRepository');

async function autoHandleGpuFailure(orderId, gpuId, userId, reason) {
  // 1. オーダー自動停止
  // ORDER_STATES（state-checker）に 'failed' は無い — 書くと遷移表未定義で注文が永久に
  // 遷移不能になる。有効な終端値 'cancelled' へ落とし、障害由来であることは
  // failureReason/failedAt フィールドと監査ログで区別する。
  // updateIf の CAS で遷移させる（読取スナップショットの全行書戻しだと、並行して
  // completed/cancelled へ進んだ注文の終端回帰や他フィールドの巻き戻しが起き得た）。
  const cancelResult = OrderRepository.updateIf(orderId,
    (o) => o.status !== 'completed' && o.status !== 'cancelled',
    { status: 'cancelled', failedAt: new Date().toISOString(), failureReason: reason });
  if (cancelResult.ok) {
    logger.info(`[AUTO-RECOVERY] Order ${orderId} cancelled due to GPU error: ${reason}`);
  }
  // 2. 多段通知
  const msg = `【GPU障害自動対応】\n注文: ${orderId}\nGPU: ${gpuId}\nユーザー: ${userId}\n理由: ${reason}\n\nオーダーを自動停止しました。`;
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
