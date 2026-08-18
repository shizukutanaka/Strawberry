// tests/reset-data.js — jest と playwright の両方から使う data/*.json の初期化。
//
// 以前は tests/globalSetup.js と tests/e2e/globalSetup.js が**同じファイル名リストを
// それぞれ手書きで持っていた**。当然のように片方だけ更新され、あとから追加した
// ledger.json は両方から漏れて、実行のたびに前回のデータを持ち越していた
// （帳簿の突き合わせが「入金の無い計上が 24 件ある」と検出して発覚した）。
//
// 対象は**リポジトリ定義から機械的に導出する**。手書きのリストは、次に
// リポジトリを足した人が同じ漏れを起こす。
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const REPO_DIR = path.join(__dirname, '../src/db/json');

// リポジトリ層を通らず、中身がオブジェクトのもの。
const OBJECT_FILES = ['revoked-tokens.json', 'notification-settings.json'];

/** src/db/json/*.js が createJsonRepository('xxx.json') に渡すファイル名を集める。 */
function repositoryDataFiles() {
  const names = new Set();
  for (const file of fs.readdirSync(REPO_DIR)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(REPO_DIR, file), 'utf-8');
    const re = /createJsonRepository\(\s*'([A-Za-z0-9_-]+\.json)'/g;
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  return [...names];
}

/** data/*.json を空の状態に戻す。 */
function resetDataFiles() {
  // クリーンチェックアウト（CI 等）には data/ が無いため作成する。無条件で
  // 書き出して確実に空状態から始める（existsSync ガードだと data/ が空の環境で
  // リセットが行われず決定性が崩れる）。
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const arrayFiles = repositoryDataFiles();
  if (arrayFiles.length === 0) {
    // 導出に失敗したまま黙って 0 件初期化すると、蓄積し続けるのに誰も気づかない。
    throw new Error('[reset-data] no repository data files found under src/db/json — refusing to run with an empty reset list');
  }
  for (const name of arrayFiles) {
    fs.writeFileSync(path.join(DATA_DIR, name), '[]', 'utf-8');
  }
  for (const name of OBJECT_FILES) {
    fs.writeFileSync(path.join(DATA_DIR, name), '{}', 'utf-8');
  }
  return { arrayFiles, objectFiles: OBJECT_FILES };
}

module.exports = { resetDataFiles, repositoryDataFiles, DATA_DIR };
