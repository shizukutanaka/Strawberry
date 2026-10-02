// サービス全体のパフォーマンス自動最適化モジュール
const { logger } = require('../utils/logger');
const { MetricsCollector } = require('../gpu/metrics');
const { appendRotated, ensureLogDir } = require('../utils/log-rotate');
const os = require('os');
const path = require('path');

const PERF_LOG_PATH = path.join(__dirname, '../../logs/perf-optimizer.log');

class AutoPerformanceOptimizer {
  constructor() {
    this.metrics = new MetricsCollector();
    this.lastOptimization = null;
    this.interval = null;
  }

  start(intervalMs = 60000) {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this.optimize(), intervalMs);
    // unref: 監視タイマーがプロセス終了を妨げない（SIGTERM 後の drain を待たせない）
    if (this.interval.unref) this.interval.unref();
    logger.info(`AutoPerformanceOptimizer started (interval: ${intervalMs}ms)`);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('AutoPerformanceOptimizer stopped');
    }
  }

  async optimize() {
    try {
      const cpuLoad = os.loadavg()[0];
      const freeMem = os.freemem() / os.totalmem();
      const gpuStats = this.metrics.gpuMetrics;
      // 例: GPU使用率（gauge は labelNames 付きなので values[0]?.value で参照）
      const gpuUsage = gpuStats.gpuUtilization ? gpuStats.gpuUtilization.get().values[0]?.value : null;
      // 例: P2P帯域（networkMetrics 側の gauge）
      const netStats = this.metrics.networkMetrics;
      const bandwidth = netStats && netStats.bandwidth ? netStats.bandwidth.get().values[0]?.value : null;
      // 最適化戦略例
      let actions = [];
      if (cpuLoad > 4) {
        actions.push('reduce_background_tasks');
      }
      if (freeMem < 0.1) {
        actions.push('clear_cache');
      }
      if (gpuUsage !== null && gpuUsage > 95) {
        actions.push('defer_new_gpu_jobs');
      }
      if (bandwidth !== null && bandwidth > 100*1024*1024) {
        actions.push('limit_p2p_bandwidth');
      }
      // ログ・記録
      const logEntry = {
        time: new Date().toISOString(),
        cpuLoad, freeMem, gpuUsage, bandwidth, actions
      };
      ensureLogDir(PERF_LOG_PATH);
      appendRotated(PERF_LOG_PATH, JSON.stringify(logEntry) + '\n');
      logger.info('auto_optimize', logEntry);
      // 実際のアクションは各サービスに通知・実行する設計（例: pub/sub, イベント）
      // ここではログのみ
    } catch (e) {
      logger.error('AutoPerformanceOptimizer error:', e);
    }
  }
}

module.exports = { AutoPerformanceOptimizer };
