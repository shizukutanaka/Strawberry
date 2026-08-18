// tests/e2e/globalSetup.js — Playwright globalSetup
// jest 側（tests/globalSetup.js）と同じ理由で data/*.json を初期化する:
// webServer は E2E 実行全体で起動しっぱなし（jest のようなスイート単位の分離が無い）
// ため、リセットしないと後続テストの「キューが空になった」といった検査が
// 無関係な先行テストの残骸を見てしまう。
// 実装は tests/reset-data.js に一本化（両者が別々にファイル名を手書きしていた）。
const { resetDataFiles } = require('../reset-data');

module.exports = async function globalSetup() {
  resetDataFiles();
};
