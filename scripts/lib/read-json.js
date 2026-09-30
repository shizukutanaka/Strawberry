// scripts/lib/read-json.js — ops 系 JSON ファイル読み込み共有ヘルパー
// docs/ 以下のフィードバック/優先度 JSON を読むスクリプト共通の堅牢化:
// - ファイル未作成（初回実行・CI のクリーンチェックアウト）→ undefined を返す
// - 破損（手編集ミス・書き込み途中の読み出し）→ 警告して undefined
//   そのまま throw させると cron/パイプラインが後続ごと落ちるため握りつぶす。
const fs = require('fs');

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[read-json] ${filePath} の読み込みに失敗: ${err.message}`);
    }
    return undefined;
  }
}

// 配列を期待するファイル用。パース結果が配列でなければ [] を返す
// （{} や "x" が書き込まれた場合に呼び出し側の .filter/.map が死なない）。
function readJsonArray(filePath) {
  const parsed = readJsonFile(filePath);
  return Array.isArray(parsed) ? parsed : [];
}

module.exports = { readJsonFile, readJsonArray };
