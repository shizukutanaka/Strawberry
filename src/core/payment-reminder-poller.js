// src/core/payment-reminder-poller.js
// 未払い支払いへのリマインド（utils/payment-reminder.js の remindPendingPayments）
// を定期実行するポーラー。cron CLI 設計だったものをプロセス内で駆動する。
// 設計: invoice-poller/backup-poller と同じ single setInterval + 再入ガード。
// 同一支払いへの再送間隔・期限切れ除外は payment-reminder 側で制御済み。
const { logger } = require('../utils/logger');
const { remindPendingPayments } = require('../utils/payment-reminder');

const POLL_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.PAYMENT_REMINDER_INTERVAL_MS) || 60 * 60 * 1000, // 既定1時間
);
const INITIAL_DELAY_MS = Math.max(
  1_000,
  Number(process.env.PAYMENT_REMINDER_INITIAL_DELAY_MS) || 10 * 60 * 1000, // 既定10分
);

let _timer = null;
let _initialTimer = null;
let _running = false;

async function pollOnce() {
  if (_running) return;
  _running = true;
  try {
    const { candidates, sent } = await remindPendingPayments();
    if (candidates > 0) {
      logger.info(`[payment-reminder-poller] reminded ${sent}/${candidates} pending payments`);
    }
  } catch (e) {
    logger.warn(`[payment-reminder-poller] remindPendingPayments failed: ${e.message}`);
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer || _initialTimer) return;
  _initialTimer = setTimeout(() => {
    _initialTimer = null;
    pollOnce().catch(() => {});
    _timer = setInterval(() => { pollOnce().catch(() => {}); }, POLL_INTERVAL_MS);
    if (_timer.unref) _timer.unref();
  }, INITIAL_DELAY_MS);
  if (_initialTimer.unref) _initialTimer.unref();
  logger.info(`[payment-reminder-poller] started (initial delay: ${INITIAL_DELAY_MS}ms, interval: ${POLL_INTERVAL_MS}ms)`);
}

function stop() {
  if (_initialTimer) { clearTimeout(_initialTimer); _initialTimer = null; }
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, pollOnce, POLL_INTERVAL_MS, INITIAL_DELAY_MS };
