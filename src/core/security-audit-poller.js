// src/core/security-audit-poller.js
// 依存脆弱性の定期監査（src/security-audit.js の runNpmAudit）を日次実行する。
// cron CLI 設計だったものをプロセス内で駆動する。同一脆弱性セットの再通知は
// security-audit 側のフィンガープリントで抑止済み。
// 設計: invoice-poller/backup-poller と同じ single setInterval + 再入ガード。
const { logger } = require('../utils/logger');

const POLL_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.SECURITY_AUDIT_INTERVAL_MS) || 24 * 60 * 60 * 1000, // 既定24時間
);
const INITIAL_DELAY_MS = Math.max(
  1_000,
  Number(process.env.SECURITY_AUDIT_INITIAL_DELAY_MS) || 15 * 60 * 1000, // 既定15分
);

let _timer = null;
let _initialTimer = null;
let _running = false;
let _audit = null;
let _auditTried = false;

function auditModule() {
  if (!_auditTried) {
    _auditTried = true;
    try { _audit = require('../security-audit'); } catch (_) { _audit = null; }
  }
  return _audit;
}

async function pollOnce() {
  const mod = auditModule();
  if (!mod || _running) return;
  _running = true;
  try {
    const r = await mod.runNpmAudit();
    if (r && r.changed) {
      logger.warn(`[security-audit-poller] new vulnerabilities detected: ${r.vulnCount}`);
    }
  } catch (e) {
    logger.warn(`[security-audit-poller] runNpmAudit failed: ${e.message}`);
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
  logger.info(`[security-audit-poller] started (initial delay: ${INITIAL_DELAY_MS}ms, interval: ${POLL_INTERVAL_MS}ms)`);
}

function stop() {
  if (_initialTimer) { clearTimeout(_initialTimer); _initialTimer = null; }
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, pollOnce, POLL_INTERVAL_MS, INITIAL_DELAY_MS };
