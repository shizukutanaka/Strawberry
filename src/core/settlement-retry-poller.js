// src/core/settlement-retry-poller.js
// settlement-retry キューの定期スイープ（invoice-poller と同型）。
// 単一 setInterval、再入は escrow の updateIf クレーム（inFlight）で排除。
const { pollOnce } = require('../payments/settlement-retry');
const { logger } = require('../utils/logger');

const POLL_INTERVAL_MS = Math.max(5000, parseInt(process.env.SETTLEMENT_RETRY_POLL_MS || '60000', 10));

let _timer = null;

async function _sweep() {
  try {
    const { scanned, results } = await pollOnce();
    const recovered = results.filter((r) => r.retried && r.ok).length;
    if (scanned > 0) logger.info(`settlement-retry-poller: scanned=${scanned} recovered=${recovered}`);
  } catch (err) {
    logger.error(`settlement-retry-poller: sweep error: ${err.message}`);
  }
}

function start() {
  if (_timer) return;
  // NODE_ENV==='test': タイマーは張らない（invoice-poller と同じ理由: スイートごとの
  // モジュールレジストリ分離でタイマーが累積しイベントループを圧迫するのを防ぐ）。
  // テストは payments/settlement-retry の pollOnce/retryOne を直接叩く。
  if (process.env.NODE_ENV === 'test') return;
  _timer = setInterval(_sweep, POLL_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  logger.info(`settlement-retry-poller: started (interval=${POLL_INTERVAL_MS}ms)`);
  _sweep();
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, POLL_INTERVAL_MS };
