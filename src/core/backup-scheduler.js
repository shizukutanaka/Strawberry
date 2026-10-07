// backup-scheduler.js — data/*.json のプロセス内定期バックアップスケジューラ。
//
// utils/backup.js の backupAll() は実装済みだが呼び出し側が存在せず、手動実行以外では
// バックアップが一切走らない（= 障害時に復元元が無いサイレント欠陥）。本モジュールは
// BACKUP_INTERVAL_HOURS で opt-in された場合のみ定期実行を起動する。
//
// 設計上の注意:
// - utils/backup.js は任意クラウド SDK（@aws-sdk 等）をトップレベル require するため、
//   それら未導入の環境では require 自体が MODULE_NOT_FOUND で失敗する。サーバ起動を
//   妨げないよう遅延 require + try/catch で包み、未導入時は警告を出して無効化する。
// - タイマーは unref 化し、Jest ワーカーや SIGTERM ドレインを阻害しない
//   （service-monitor のタイマーリークと同型の問題を避ける）。
// - テスト環境（NODE_ENV=test）では既定で起動しない。

const { logger } = require('../utils/logger');
const { registerDaemon, unregisterDaemon } = require('../utils/daemon-registry');

// 起動中タイマーの共有ハンドル（stopBackupScheduler / 二重 start ガード用）
let _timer = null;

// BACKUP_INTERVAL_HOURS の解釈。0/未設定/不正値は「無効」を返す。
function resolveIntervalMs(env) {
  const raw = env.BACKUP_INTERVAL_HOURS;
  if (raw === undefined || raw === null || raw === '') return 0;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    logger.warn(`backup-scheduler: invalid BACKUP_INTERVAL_HOURS="${raw}" — disabled`);
    return 0;
  }
  return Math.round(hours * 3600e3);
}

// 定期バックアップを開始する。返り値はタイマー（無効時・依存不足時は null）。
// options:
//   intervalMs   — 直接指定（省略時は環境変数から解決）
//   backupAll    — 実行関数の差し替え（テスト用）
//   allowInTest  — NODE_ENV=test でも起動を許可（テスト用）
function startBackupScheduler(options = {}) {
  // 呼び直しは必ず再評価: 無効化された場合にも既存タイマーを残さない
  if (_timer) { clearInterval(_timer); _timer = null; }
  const intervalMs = options.intervalMs !== undefined
    ? options.intervalMs
    : resolveIntervalMs(process.env);
  if (intervalMs <= 0) return null;
  if (process.env.NODE_ENV === 'test' && !options.allowInTest) return null;

  let backupAll = options.backupAll;
  if (!backupAll) {
    try {
      ({ backupAll } = require('../utils/backup'));
    } catch (e) {
      logger.warn(
        `backup-scheduler: utils/backup could not be loaded (${e.message}) — ` +
        'scheduled backups disabled. Install optional cloud SDKs or fix the module.'
      );
      return null;
    }
  }

  // 前回実行が未完なら今回分をスキップする単一フライト（低速なクラウド送信で
  // tick が重なってもバックアップが多重走らないようにする）。
  let inFlight = false;
  const run = () => {
    if (inFlight) return;
    inFlight = true;
    let done;
    try {
      done = Promise.resolve(backupAll());
    } catch (e) {
      inFlight = false;
      logger.error(`scheduled backup failed: ${e.message}`);
      return;
    }
    done
      .catch(e => logger.error(`scheduled backup failed: ${e.message}`))
      .finally(() => { inFlight = false; });
  };
  // モジュール共有ハンドルに保持（stopBackupScheduler で確定的に停止できるよう
  // にするため — service-monitor._timer と同型）。
  _timer = setInterval(run, intervalMs);
  if (typeof _timer.unref === 'function') _timer.unref();
  registerDaemon('backup-scheduler', stopBackupScheduler);
  logger.info(`backup-scheduler: started (every ${Math.round((intervalMs / 3600e3) * 100) / 100}h)`);
  return _timer;
}

// 定期実行を停止する。未起動時は no-op（他デーモンの stopMonitor/stopSLATracker と
// 同一規約 — graceful shutdown やデーモン registry 化の際に一括停止できるようにする）。
function stopBackupScheduler() {
  unregisterDaemon('backup-scheduler');
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { startBackupScheduler, stopBackupScheduler, resolveIntervalMs };
