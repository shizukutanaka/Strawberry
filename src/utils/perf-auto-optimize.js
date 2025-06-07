// サービス全体のパフォーマンス自動最適化ユーティリティ
const os = require('os');
const { logger } = require('./logger');
const { resilientNotify } = require('./resilient-notify');

// 設定値
const CPU_THRESHOLD = 0.90; // 90%
const MEM_THRESHOLD = 0.90; // 90%
const CHECK_INTERVAL = 60 * 1000; // 1分ごと

let lastAlert = 0;

function getCpuUsage() {
  // 1秒間のCPU使用率を計測
  return new Promise(resolve => {
    const start = os.cpus();
    setTimeout(() => {
      const end = os.cpus();
      let idleDiff = 0, totalDiff = 0;
      for (let i = 0; i < start.length; i++) {
        const s = start[i], e = end[i];
        const idle = e.times.idle - s.times.idle;
        const total = Object.keys(s.times).reduce((acc, k) => acc + (e.times[k] - s.times[k]), 0);
        idleDiff += idle;
        totalDiff += total;
      }
      const usage = 1 - idleDiff / totalDiff;
      resolve(usage);
    }, 1000);
  });
}

function getMemUsage() {
  return 1 - os.freemem() / os.totalmem();
}

async function autoOptimize() {
  const cpu = await getCpuUsage();
  const mem = getMemUsage();
  logger.info('[perf-auto-optimize] CPU:', cpu, 'MEM:', mem);
  if ((cpu > CPU_THRESHOLD || mem > MEM_THRESHOLD) && Date.now() - lastAlert > 10 * 60 * 1000) {
    lastAlert = Date.now();
    const msg = `[Strawberry] サーバー高負荷検知\nCPU: ${(cpu*100).toFixed(1)}% MEM: ${(mem*100).toFixed(1)}%`;
    await resilientNotify(msg);
    logger.warn('[perf-auto-optimize] 高負荷通知:', msg);
    // TODO: 必要に応じて自動スケール/再起動/リソース解放等の処理をここに実装
  }
}

function startAutoOptimize() {
  setInterval(autoOptimize, CHECK_INTERVAL);
}

module.exports = { startAutoOptimize, autoOptimize, getCpuUsage, getMemUsage };
