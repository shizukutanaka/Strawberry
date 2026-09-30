// tests/e2e/globalTeardown.js — Playwright globalTeardown
// globalSetup が退避した live data/*.json を復元する。snapshot が無ければ
// （例: E2E_BASE_URL 指定で外部サーバを使った等）何もしない。
const { _private } = require('./globalSetup');

module.exports = async function globalTeardown() {
  try {
    _private.restoreSnapshot();
  } catch (err) {
    // 復元失敗でもレポート生成を妨げない。snapshot は残るため次回の
    // globalSetup が先頭で復元を試みる。
    console.warn(`[e2e teardown] data/ snapshot restore failed: ${err.message}`);
  }
};
