// audit-anchor-scheduler.js — 監査ログ Merkle アンカーのプロセス内定期実行。
//
// src/security/audit-anchor.js の anchorAuditLogFile() は実装済みだが呼び出し側が
// 存在せず、アンカーが一切生成されない（= OpenTimestamps 提出元の root が無い
// サイレント欠陥）。本モジュールは AUDIT_ANCHOR_INTERVAL_HOURS で opt-in された
// 場合のみ定期実行を起動する。timer 健全化・単一フライトは backup-scheduler と同型。
//
// 設計上の注意:
// - anchorAuditLogFile は同期 I/O で冪等（append のみ）だが、大きな監査ログでは
//   スキャンに時間を要し得るため tick 重なりを単一フライトで抑止する。
// - タイマーは unref 化し、Jest ワーカーや SIGTERM ドレインを阻害しない。
// - テスト環境（NODE_ENV=test）では既定で起動しない。

const { logger } = require('../utils/logger');

// AUDIT_ANCHOR_INTERVAL_HOURS の解釈。0/未設定/不正値は「無効」を返す。
function resolveIntervalMs(env) {
  const raw = env.AUDIT_ANCHOR_INTERVAL_HOURS;
  if (raw === undefined || raw === null || raw === '') return 0;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    logger.warn(`audit-anchor-scheduler: invalid AUDIT_ANCHOR_INTERVAL_HOURS="${raw}" — disabled`);
    return 0;
  }
  return Math.round(hours * 3600e3);
}

// 定期アンカーを開始する。返り値はタイマー（無効時は null）。
// options:
//   intervalMs   — 直接指定（省略時は環境変数から解決）
//   anchor       — 実行関数の差し替え（テスト用）
//   allowInTest  — NODE_ENV=test でも起動を許可（テスト用）
function startAuditAnchorScheduler(options = {}) {
  const intervalMs = options.intervalMs !== undefined
    ? options.intervalMs
    : resolveIntervalMs(process.env);
  if (intervalMs <= 0) return null;
  if (process.env.NODE_ENV === 'test' && !options.allowInTest) return null;

  const anchor = options.anchor
    || (() => require('../security/audit-anchor').anchorAuditLogFile());

  // 前回実行が未完なら今回分をスキップする単一フライト（低速な fs 走査で
  // tick が重なってもアンカー構築が多重走らないようにする）。
  let inFlight = false;
  const run = () => {
    if (inFlight) return;
    inFlight = true;
    let done;
    try {
      done = Promise.resolve(anchor());
    } catch (e) {
      inFlight = false;
      logger.error(`scheduled audit anchor failed: ${e.message}`);
      return;
    }
    done
      .catch(e => logger.error(`scheduled audit anchor failed: ${e.message}`))
      .finally(() => { inFlight = false; });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(`audit-anchor-scheduler: started (every ${Math.round((intervalMs / 3600e3) * 100) / 100}h)`);
  return timer;
}

module.exports = { startAuditAnchorScheduler, resolveIntervalMs };
