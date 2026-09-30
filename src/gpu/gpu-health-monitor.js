// GPU健康状態・温度・ファン・メモリエラー自動検知＋通知
const { logger } = require('../utils/logger');
const { recordGpuError } = require('./gpu-error-history');

// GPU情報取得はnvidia-smi, rocm-smi, WMI等で拡張可能
const execSync = require('child_process').execSync;

// nvidia-smi はドライバ障害時に応答しなくなることがある。execSync はイベントループを
// ブロックするため、タイムアウト無しでは nvidia-smi ハング = プロセス全体の停止になる。
const NVIDIA_SMI_TIMEOUT_MS = 15_000;

function getNvidiaGpuHealth() {
  try {
    const output = execSync('nvidia-smi --query-gpu=uuid,temperature.gpu,fan.speed,utilization.gpu,memory.total,memory.used,memory.free,retired_pages.pending,retired_pages.count --format=csv,noheader,nounits', {
      encoding: 'utf-8',
      timeout: NVIDIA_SMI_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return output.trim().split('\n').map(line => {
      const [uuid, temp, fan, util, memTotal, memUsed, memFree, retiredPending, retiredCount] = line.split(',').map(s => s.trim());
      return {
        uuid, temp: Number(temp), fan: Number(fan), util: Number(util),
        memTotal: Number(memTotal), memUsed: Number(memUsed), memFree: Number(memFree),
        retiredPending: Number(retiredPending), retiredCount: Number(retiredCount)
      };
    });
  } catch (e) {
    logger.error('nvidia-smi取得失敗', e.message);
    return [];
  }
}

// 閾値評価を純関数化（テスト容易性）。異常項目の配列を返す。
function evaluateGpuHealth(gpu, thresholds) {
  const alerts = [];
  if (gpu.temp > thresholds.temp) alerts.push(`温度異常: ${gpu.temp}℃`);
  if (gpu.fan > thresholds.fan) alerts.push(`ファン回転数異常: ${gpu.fan}%`);
  if (gpu.memTotal > 0 && gpu.memUsed / gpu.memTotal * 100 > thresholds.mem) {
    alerts.push(`メモリ使用率異常: ${gpu.memUsed}/${gpu.memTotal}`);
  }
  if (gpu.retiredPending > 0 || gpu.retiredCount >= thresholds.retired) {
    alerts.push(`メモリエラー: retired=${gpu.retiredCount}, pending=${gpu.retiredPending}`);
  }
  return alerts;
}

// GPU 単位で「最後に通知した異常の組み合わせ」を記憶する。
// 同じ異常が継続している限り再通知しない（アラート嵐防止 — 60s tick × 障害継続で
// 毎分通知＋履歴追記されていた）。正常に戻ればキーを消し、次の障害で再び通知する。
const lastAlertSignature = new Map(); // uuid -> signature

function buildAlertSignature(alerts) {
  return alerts.join('|');
}

async function checkGpuHealthTick(thresholds) {
  const gpus = getNvidiaGpuHealth();
  for (const gpu of gpus) {
    const alerts = evaluateGpuHealth(gpu, thresholds);
    const signature = alerts.length > 0 ? buildAlertSignature(alerts) : null;
    const previous = lastAlertSignature.get(gpu.uuid);
    if (signature === null) {
      lastAlertSignature.delete(gpu.uuid); // 正常復帰 — 次回障害は新規イベントとして通知
      continue;
    }
    if (signature === previous) continue; // 同一異常の継続 — 再通知しない
    lastAlertSignature.set(gpu.uuid, signature);
    // recordGpuError が履歴保存 + 多段通知（LINE/Discord/Email）を担うため
    // ここで二重に通知しない（旧実装は recordGpuError 内通知 + 独自通知で重複していた）。
    await recordGpuError(gpu.uuid, `[GPU健康異常] ${alerts.join('; ')}`, { gpu });
  }
}

let healthTimer = null;
let tickRunning = false;

function monitorGpuHealth(thresholds = { temp: 85, fan: 95, mem: 95, retired: 1 }, intervalMs = 60000) {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (tickRunning) return; // 前回 tick が未完了なら飛ばす（通知重なり防止）
    tickRunning = true;
    try {
      await checkGpuHealthTick(thresholds);
    } catch (e) {
      logger.error('GPU健康チェック失敗', e.message);
    } finally {
      tickRunning = false;
    }
  }, intervalMs);
  // 監視タイマーがプロセスの生存を引き延ばさないようにする（SIGTERM 即終了可能に）。
  if (typeof healthTimer.unref === 'function') healthTimer.unref();
  logger.info('GPU健康状態自動監視開始');
  return healthTimer;
}

function stopGpuHealthMonitor() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

module.exports = {
  monitorGpuHealth,
  stopGpuHealthMonitor,
  _evaluateGpuHealth: evaluateGpuHealth,
  _checkGpuHealthTick: checkGpuHealthTick,
  _lastAlertSignature: lastAlertSignature,
};
