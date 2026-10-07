// 常駐ループの一元管理（監査 i10 — 複数デーモンループの乱立対策）。
// 各デーモンは周期タイマーを張った時点で registerDaemon(name, stopFn) し、
// graceful shutdown では server.js が stopAllDaemons() を呼んで逆順に停止する。
// レジストリ自体は Map のみで挙動を持たない — 登録しなくても従来通り動く。
const { logger } = require('./logger');

const _daemons = new Map();

function registerDaemon(name, stopFn) {
  if (typeof stopFn !== 'function') {
    throw new TypeError(`daemon-registry: stopFn for "${name}" must be a function`);
  }
  _daemons.set(name, stopFn);
}

function unregisterDaemon(name) {
  _daemons.delete(name);
}

// 起動順の逆順に停止する。1件の失敗が後続デーモンの停止を阻害しないよう個別にガード。
function stopAllDaemons() {
  const entries = [..._daemons].reverse();
  for (const [name, stopFn] of entries) {
    try {
      stopFn();
    } catch (e) {
      logger.warn(`daemon-registry: stop failed for "${name}": ${e.message}`);
    }
  }
  _daemons.clear();
}

// テスト・診断用の読み取り専用ビュー
function registeredDaemons() {
  return [..._daemons.keys()];
}

module.exports = { registerDaemon, unregisterDaemon, stopAllDaemons, registeredDaemons };
