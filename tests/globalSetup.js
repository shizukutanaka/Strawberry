// tests/globalSetup.js — Jest globalSetup
// テスト実行の前に JSON データファイルを初期化する。放置すると実行のたびに
// 蓄積し、getAll() が線形に遅くなる。
//
// 対象ファイルは**リポジトリ定義から機械的に導出する**。以前はここに名前を手で
// 並べており、あとから追加した ledger.json が漏れて毎回持ち越されていた
// （帳簿の突き合わせが「入金の無い計上が 125 件ある」と正しく検出して発覚した）。
// 手書きのリストは、次にリポジトリを足した人が同じ漏れを起こす。
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const REPO_DIR = path.join(__dirname, '../src/db/json');

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

module.exports = async function globalSetup() {
  // 配列ではなくオブジェクトを持つファイル（リポジトリ層を通らないもの）
  const objectFiles = ['revoked-tokens.json', 'notification-settings.json'];

  // CI のクリーンチェックアウトには data/ ディレクトリ自体が存在しない
  // （data/*.json は未コミット）。ローカルでは常に存在するため露見しなかったが、
  // ディレクトリなしで writeFileSync すると ENOENT で全スイートが起動前に死ぬ。
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const arrayFiles = repositoryDataFiles();
  if (arrayFiles.length === 0) {
    // 導出に失敗したまま黙って 0 件初期化すると、蓄積し続けるのに誰も気づかない。
    throw new Error('[globalSetup] no repository data files found under src/db/json — refusing to run with an empty reset list');
  }
  for (const name of arrayFiles) {
    fs.writeFileSync(path.join(DATA_DIR, name), '[]', 'utf-8');
  }
  for (const name of objectFiles) {
    fs.writeFileSync(path.join(DATA_DIR, name), '{}', 'utf-8');
  }
};
