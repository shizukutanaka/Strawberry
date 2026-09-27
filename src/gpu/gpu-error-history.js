// GPUごとの障害・エラー履歴記録＋障害発生時の多段通知
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../db/json/atomicWrite');
const { withLock } = require('../utils/async-lock');
const { sendNotification, NotifyType } = require('../utils/notifier');
const { logger } = require('../utils/logger');

const HISTORY_PATH = path.join(__dirname, '../../logs/gpu-error-history.json');
// 1ファイルに全 GPU の履歴を保持するため、gpu-health-monitor / gpu-liveness-monitor
// からの並行 recordGpuError が read-modify-write で失う更新を防ぐプロセス内 mutex。
const HISTORY_LOCK = 'gpu-error-history';
// 履歴ファイルの鍵数上限。gpuId は検出 GPU の uuid だが呼び出し側が任意文字列を
// 渡せるため、無制限だとファイルが永久増殖する。上限超過時は最も古い鍵から除く。
const MAX_GPU_KEYS = 1000;

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch (e) {
    logger.error('Failed to load GPU error history:', e);
    // 破損ファイルを退避: このまま {} を返すと呼び出し側の saveHistory が破損ファイルを
    // 上書きし、クラッシュ直前の履歴（障害解析の証跡）が消える。.corrupt-* へ改名して
    // 保持し、新しい履歴は空から開始する。
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(HISTORY_PATH, `${HISTORY_PATH}.corrupt-${stamp}`);
    } catch (_) { /* 退避失敗時は上書きを許容する（観測可能性を失わない） */ }
    return {};
  }
}

function saveHistory(history) {
  try {
    atomicWriteJSON(HISTORY_PATH, history);
  } catch (e) {
    logger.error('Failed to save GPU error history:', e);
  }
}

async function recordGpuError(gpuId, error, context = {}) {
  // ロック内: load→mutate→save を直列化。通知送信はロック外に置く
  // （ネットワーク待ちで他 GPU の記録をブロックしない）。
  const entry = await withLock(HISTORY_LOCK, async () => {
    const history = loadHistory();
    if (!history[gpuId]) {
      // 鍵数上限: 未知の新規 gpuId で上限超過なら最古の挿入キーから除く
      const keys = Object.keys(history);
      if (keys.length >= MAX_GPU_KEYS) {
        delete history[keys[0]];
      }
      history[gpuId] = [];
    }
    const e = {
      time: new Date().toISOString(),
      error: typeof error === 'string' ? error : error.message,
      stack: error.stack || null,
      context
    };
    history[gpuId].push(e);
    // 最大100件に制限
    if (history[gpuId].length > 100) history[gpuId] = history[gpuId].slice(-100);
    saveHistory(history);
    return e;
  });

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
