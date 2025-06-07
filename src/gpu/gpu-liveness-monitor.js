// GPU貸出/借入時のリアルタイム稼働監視・死活監視
const { logger } = require('../utils/logger');
const { sendNotification, NotifyType } = require('../utils/notifier');
const { recordGpuError } = require('./gpu-error-history');
const { MetricsCollector } = require('./metrics');

const ACTIVE_GPU_TIMEOUT_MS = 60 * 1000; // 1分間ハートビートがなければ異常

class GpuLivenessMonitor {
  constructor() {
    this.activeRentals = new Map(); // orderId: { gpuId, userId, lastHeartbeat }
    this.metrics = new MetricsCollector();
    this.interval = null;
  }

  start(intervalMs = 30000) {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this.checkLiveness(), intervalMs);
    logger.info(`GpuLivenessMonitor started (interval: ${intervalMs}ms)`);
  }

  // 貸出/借入開始時に呼ぶ
  registerRental(orderId, gpuId, userId) {
    this.activeRentals.set(orderId, { gpuId, userId, lastHeartbeat: Date.now() });
  }

  // ハートビート受信時に呼ぶ
  heartbeat(orderId) {
    if (this.activeRentals.has(orderId)) {
      this.activeRentals.get(orderId).lastHeartbeat = Date.now();
    }
  }

  // 定期的に全貸出GPUの死活を監視
  async checkLiveness() {
    const now = Date.now();
    for (const [orderId, rental] of this.activeRentals.entries()) {
      if (now - rental.lastHeartbeat > ACTIVE_GPU_TIMEOUT_MS) {
        // 死活異常検知
        logger.warn(`[GPU監視] Order:${orderId} GPU:${rental.gpuId} 死活異常`);
        await recordGpuError(rental.gpuId, 'GPU死活監視異常', { orderId, userId: rental.userId });
        // 多段通知
        const msg = `【GPU死活監視異常】\n注文: ${orderId}\nGPU: ${rental.gpuId}\nユーザー: ${rental.userId}\n\n1分間ハートビートなし`;
        const channels = [
          process.env.LINE_TOKEN ? { type: NotifyType.LINE, opts: { token: process.env.LINE_TOKEN } } : null,
          process.env.DISCORD_WEBHOOK ? { type: NotifyType.DISCORD, opts: { webhookUrl: process.env.DISCORD_WEBHOOK } } : null,
          process.env.EMAIL_TO ? { type: NotifyType.EMAIL, opts: { to: process.env.EMAIL_TO, subject: '【Strawberry】GPU死活異常' } } : null
        ].filter(Boolean);
        for (const ch of channels) {
          try { await sendNotification(ch.type, msg, ch.opts); } catch(e) { logger.error('通知失敗', { channel: ch.type, error: e.message }); }
        }
        // 自動停止・返金等の自動処理（今後拡張）
        this.activeRentals.delete(orderId);
      }
    }
  }
}

module.exports = { GpuLivenessMonitor };
