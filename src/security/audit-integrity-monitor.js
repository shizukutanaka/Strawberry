// src/security/audit-integrity-monitor.js
//
// 監査ログの HMAC ハッシュチェーンを稼働中も定期的に検証する。
//
// 問: audit-log.js は「HMAC ハッシュチェーンで tamper-evident」と主張している
// （audit-anchor.js のヘッダも同じ前提に乗っている）。tamper-evident は、誰かが
// それを見て初めて意味を持つ。**誰がいつ見るのか。**
// 答（修正前）: 起動時、プロセス内キャッシュを作る最初の appendAuditLog 呼び出しの中で
// 一度だけ（src/utils/audit-log.js の _getOrInitPrevHash）。それ以降は prevHash を
// キャッシュから引くだけで、ディスク上の実ファイルを見直さない。稼働中にログファイルへ
// 直接書き込まれる改ざんは、次の再起動まで検出されない。verifyAuditLogIntegrity() 自体は
// テストからしか呼ばれていなかった。
//
// このモジュールは同じ検証（audit-log.checkIntegrity()）を setInterval で回す。
// 検出しても自動修復・強制停止はしない — 断定できない異常は記録・通知に留め、
// 資金や可用性を自動で動かさない、というこのコードベース全体の方針に合わせる。
// 設計は src/payments/earnings-sweeper.js / src/security/anchor-scheduler.js と同型
// （setInterval + 再入ガード + unref）。
const { logger } = require('../utils/logger');
const auditLog = require('../utils/audit-log');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 分

function intervalMs() {
  const v = Number(process.env.AUDIT_INTEGRITY_CHECK_INTERVAL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_INTERVAL_MS;
}

let _timer = null;
let _running = false;

/** 1 回分の検証を実行する。管理者スイープやテストからも直接呼べる。 */
function runOnce() {
  if (_running) return { skipped: 'already-running' };
  _running = true;
  try {
    const ok = auditLog.checkIntegrity();
    if (!ok) {
      logger.error('[audit-integrity-monitor] audit log hash chain mismatch detected — see auditIntegrityHealth()');
    }
    return { ok };
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer) return;
  const ms = intervalMs();
  _timer = setInterval(() => {
    try { runOnce(); } catch (e) { logger.warn(`audit-integrity-monitor: check failed: ${e.message}`); }
  }, ms);
  if (_timer.unref) _timer.unref();
  logger.info(`[audit-integrity-monitor] started (interval=${ms}ms)`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, runOnce, intervalMs, DEFAULT_INTERVAL_MS };
