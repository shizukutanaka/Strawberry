// tests/globalSetup.js — Jest globalSetup
// テスト実行の前に data/*.json を初期化する。放置すると実行のたびに蓄積し、
// getAll() が線形に遅くなる。実装は tests/reset-data.js に一本化してある
// （playwright 側と同じリストを二重に手書きしていて、片方だけ更新される事故が起きた）。
const { resetDataFiles } = require('./reset-data');

module.exports = async function globalSetup() {
  resetDataFiles();
};
