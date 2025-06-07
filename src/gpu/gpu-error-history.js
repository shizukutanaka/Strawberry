// GPUごとの障害・エラー履歴記録＋障害発生時の多段通知
const fs = require('fs');
const path = require('path');
const { sendNotification, NotifyType } = require('../utils/notifier');
const { logger } = require('../utils/logger');

const HISTORY_PATH = path.join(__dirname, '../../logs/gpu-error-history.json');

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch (e) {
    logger.error('Failed to load GPU error history:', e);
    return {};
  }
}

function saveHistory(history) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch (e) {
    logger.error('Failed to save GPU error history:', e);
  }
}

async function recordGpuError(gpuId, error, context = {}) {
  const history = loadHistory();
  if (!history[gpuId]) history[gpuId] = [];
  const entry = {
    time: new Date().toISOString(),
    error: typeof error === 'string' ? error : error.message,
    stack: error.stack || null,
    context
  };
  history[gpuId].push(entry);
  // 最大100件に制限
  if (history[gpuId].length > 100) history[gpuId] = history[gpuId].slice(-100);
  saveHistory(history);

  // 多段通知
  const msg = `【GPU障害検知】\nGPU: ${gpuId}\n${entry.error}\n発生時刻: ${entry.time}`;
  const channels = [
    process.env.LINE_TOKEN ? { type: NotifyType.LINE, opts: { token: process.env.LINE_TOKEN } } : null,
    process.env.DISCORD_WEBHOOK ? { type: NotifyType.DISCORD, opts: { webhookUrl: process.env.DISCORD_WEBHOOK } } : null,
    process.env.EMAIL_TO ? { type: NotifyType.EMAIL, opts: { to: process.env.EMAIL_TO, subject: '【Strawberry】GPU障害発生' } } : null
  ].filter(Boolean);
  for (const ch of channels) {
    try { await sendNotification(ch.type, msg, ch.opts); } catch(e) { logger.error('通知失敗', { channel: ch.type, error: e.message }); }
  }
  logger.gpuEvent('error', { gpuId, ...entry });
}

function getGpuErrorHistory(gpuId) {
  const history = loadHistory();
  return history[gpuId] || [];
}

module.exports = { recordGpuError, getGpuErrorHistory };
