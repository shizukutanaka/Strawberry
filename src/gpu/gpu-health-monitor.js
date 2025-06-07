// GPU健康状態・温度・ファン・メモリエラー自動検知＋多段通知
const { logger } = require('../utils/logger');
const { sendNotification, NotifyType } = require('../utils/notifier');
const { recordGpuError } = require('./gpu-error-history');
const os = require('os');

// GPU情報取得はnvidia-smi, rocm-smi, WMI等で拡張可能
const execSync = require('child_process').execSync;

function getNvidiaGpuHealth() {
  try {
    const output = execSync('nvidia-smi --query-gpu=uuid,temperature.gpu,fan.speed,utilization.gpu,memory.total,memory.used,memory.free,retired_pages.pending,retired_pages.count --format=csv,noheader,nounits', { encoding: 'utf-8' });
    return output.trim().split('\n').map(line => {
      const [uuid, temp, fan, util, memTotal, memUsed, memFree, retiredPending, retiredCount] = line.split(',').map(s => s.trim());
      return {
        uuid, temp: Number(temp), fan: Number(fan), util: Number(util),
        memTotal: Number(memTotal), memUsed: Number(memUsed), memFree: Number(memFree),
        retiredPending: Number(retiredPending), retiredCount: Number(retiredCount)
      };
    });
  } catch (e) {
    logger.error('nvidia-smi取得失敗', e);
    return [];
  }
}

async function monitorGpuHealth(thresholds = { temp: 85, fan: 95, mem: 95, retired: 1 }, intervalMs = 60000) {
  setInterval(async () => {
    const gpus = getNvidiaGpuHealth();
    for (const gpu of gpus) {
      let alerts = [];
      if (gpu.temp > thresholds.temp) alerts.push(`温度異常: ${gpu.temp}℃`);
      if (gpu.fan > thresholds.fan) alerts.push(`ファン回転数異常: ${gpu.fan}%`);
      if (gpu.memUsed / gpu.memTotal * 100 > thresholds.mem) alerts.push(`メモリ使用率異常: ${gpu.memUsed}/${gpu.memTotal}`);
      if (gpu.retiredPending > 0 || gpu.retiredCount >= thresholds.retired) alerts.push(`メモリエラー: retired=${gpu.retiredCount}, pending=${gpu.retiredPending}`);
      if (alerts.length > 0) {
        const msg = `【GPU健康異常】\nGPU: ${gpu.uuid}\n${alerts.join('\n')}`;
        await recordGpuError(gpu.uuid, alerts.join(';'), { gpu });
        const channels = [
          process.env.LINE_TOKEN ? { type: NotifyType.LINE, opts: { token: process.env.LINE_TOKEN } } : null,
          process.env.DISCORD_WEBHOOK ? { type: NotifyType.DISCORD, opts: { webhookUrl: process.env.DISCORD_WEBHOOK } } : null,
          process.env.EMAIL_TO ? { type: NotifyType.EMAIL, opts: { to: process.env.EMAIL_TO, subject: '【Strawberry】GPU健康異常' } } : null
        ].filter(Boolean);
        for (const ch of channels) {
          try { await sendNotification(ch.type, msg, ch.opts); } catch(e) { logger.error('通知失敗', { channel: ch.type, error: e.message }); }
        }
      }
    }
  }, intervalMs);
  logger.info('GPU健康状態自動監視開始');
}

module.exports = { monitorGpuHealth };
