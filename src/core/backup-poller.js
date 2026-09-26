// src/core/backup-poller.js
// 世代バックアップ（utils/backup.js の backupAll）を定期実行するポーラー。
// 設計: invoice-poller と同じ single setInterval + 再入ガード。
// backup モジュールは任意依存（cloud-storage 系）を含むため、ロード失敗時は
// 自身を停止して警告する（未導入環境でログスパムしない）。
const { logger } = require('../utils/logger');

const POLL_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.BACKUP_INTERVAL_MS) || 6 * 60 * 60 * 1000, // 既定6時間
);
// 初回実行の遅延（起動直後の I/O 集中を避ける）
const INITIAL_DELAY_MS = Math.max(
  1_000,
  Number(process.env.BACKUP_INITIAL_DELAY_MS) || 5 * 60 * 1000, // 既定5分
);

let _timer = null;
let _initialTimer = null;
let _running = false;
let _backup = null;
let _backupTried = false;

function backupModule() {
  if (!_backupTried) {
    _backupTried = true;
    try { _backup = require('../utils/backup'); } catch (_) { _backup = null; }
  }
  return _backup;
}

async function pollOnce() {
  const mod = backupModule();
  if (!mod || _running) return;
  _running = true;
  try {
    await mod.backupAll();
  } catch (e) {
    logger.warn(`[backup-poller] backupAll failed: ${e.message}`);
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer || _initialTimer) return;
  _initialTimer = setTimeout(() => {
    _initialTimer = null;
    // 起動直後に1回実行し、以後は定期実行
    pollOnce().catch(() => {});
    _timer = setInterval(() => { pollOnce().catch(() => {}); }, POLL_INTERVAL_MS);
    if (_timer.unref) _timer.unref();
  }, INITIAL_DELAY_MS);
  if (_initialTimer.unref) _initialTimer.unref();
  logger.info(`[backup-poller] started (initial delay: ${INITIAL_DELAY_MS}ms, interval: ${POLL_INTERVAL_MS}ms)`);
}

function stop() {
  if (_initialTimer) { clearTimeout(_initialTimer); _initialTimer = null; }
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, pollOnce, POLL_INTERVAL_MS, INITIAL_DELAY_MS };
