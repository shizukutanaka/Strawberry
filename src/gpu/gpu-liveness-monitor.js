// GPU貸出/借入時のリアルタイム稼働監視・死活監視
const { logger } = require('../utils/logger');
const { recordGpuError } = require('./gpu-error-history');
const { MetricsCollector } = require('./metrics');

const ACTIVE_GPU_TIMEOUT_MS = 60 * 1000; // 1分間ハートビートがなければ異常

class GpuLivenessMonitor {
  constructor() {
    this.activeRentals = new Map(); // orderId: { gpuId, userId, lastHeartbeat }
    this._metrics = null; // 遅延生成 — メトリクス未使用でも Registry 登録コスト/衝突を避ける
    this.interval = null;
    this._checkRunning = false;
  }

  // MetricsCollector は生成時にメトリクス定義を行うため、利用されない限り
  // コンストラクタで生成しない（監視のみの利用で metrics 登録が走るのを防ぐ）。
  get metrics() {
    if (!this._metrics) this._metrics = new MetricsCollector();
    return this._metrics;
  }

  start(intervalMs = 30000) {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => {
      // 前回のチェックが未完了ならスキップ（async 処理の重なりで通知・履歴が二重化するのを防ぐ）
      if (this._checkRunning) return;
      this._checkRunning = true;
      Promise.resolve()
        .then(() => this.checkLiveness())
        .catch(e => logger.error('liveness check failed', e.message))
        .finally(() => { this._checkRunning = false; });
    }, intervalMs);
    // 監視タイマーがプロセス終了を妨げないようにする（SIGTERM で drain 不要に）。
    if (typeof this.interval.unref === 'function') this.interval.unref();
    logger.info(`GpuLivenessMonitor started (interval: ${intervalMs}ms)`);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
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
        // 死活異常検知。recordGpuError が履歴保存と多段通知（LINE/Discord/Email）を
        // 担うため、ここで別途通知しない（旧実装は二重通知だった）。
        logger.warn(`[GPU監視] Order:${orderId} GPU:${rental.gpuId} 死活異常`);
        await recordGpuError(
          rental.gpuId,
          `GPU死活監視異常: 注文=${orderId} ユーザー=${rental.userId} — 1分間ハートビートなし`,
          { orderId, userId: rental.userId }
        );
        // 自動停止・返金等の自動処理（今後拡張）
        this.activeRentals.delete(orderId);
      }
    }
  }
}

module.exports = { GpuLivenessMonitor };
