// src/utils/process-guards.js
// プロセスレベルの最終防衛ライン（uncaughtException / unhandledRejection）。
// これが無いと、未処理の例外や Promise リジェクションが文脈ログを残さずプロセスを落とす
// （Node 15+ は unhandledRejection でデフォルト異常終了する）。本番では障害調査のために
// 必ず logger に記録し、uncaughtException 後は「状態が不定なので通常運用を継続しない」
// という Node 公式ガイダンスに従って接続を閉じてから非ゼロ終了する（再起動はオーケストレータに委ねる）。
//
// テスト容易性のため process/exit/getServer を注入可能にする。

function _describe(e) {
  return e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
}

/**
 * @param {object} opts
 * @param {{error: Function}} opts.logger
 * @param {Function} [opts.getServer] 現在の HTTP サーバを返す（uncaughtException 時に close する）
 * @param {NodeJS.EventEmitter} [opts.proc] 既定は global process（テストで差し替え可能）
 * @param {Function} [opts.exit] 既定は process.exit（テストで差し替え可能）
 * @param {number} [opts.forceExitMs] close がハングした場合の強制終了猶予（既定 10s）
 */
function registerProcessGuards({ logger, getServer, proc = process, exit, forceExitMs = 10000 } = {}) {
  const doExit = typeof exit === 'function' ? exit : (code) => process.exit(code);

  // 1 件の未処理リジェクションで API 全体を落とさず、文脈を残して継続する
  // （原因はログから修正可能にする）。
  proc.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: _describe(reason) });
  });

  // uncaughtException 後はプロセス状態が不定。継続せず、進行中の接続を閉じて exit(1)。
  let handling = false;
  proc.on('uncaughtException', (err) => {
    logger.error('Uncaught exception; initiating shutdown', { error: _describe(err) });
    if (handling) return; // 多重発火に備えて冪等化
    handling = true;
    const force = setTimeout(() => doExit(1), forceExitMs);
    if (force && force.unref) force.unref();
    const srv = typeof getServer === 'function' ? getServer() : null;
    if (srv && typeof srv.close === 'function') {
      srv.close(() => { clearTimeout(force); doExit(1); });
    } else {
      clearTimeout(force);
      doExit(1);
    }
  });
}

module.exports = { registerProcessGuards };
