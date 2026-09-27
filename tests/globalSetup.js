// tests/globalSetup.js — Jest globalSetup
// Reset JSON data files before each test run to prevent unbounded accumulation
// that would slow down getAll() calls as the suite grows over time.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');

module.exports = async function globalSetup() {
  // arrayFiles のリストは src/db/json/ の createJsonRepository('X.json') 呼び出しと
  // 対応させる（網羅性は tests/globalSetup-coverage.test.js が構造的に検証する）。
  // ここに無いリポジトリはリセットされず、レコードがテスト実行間で蓄積して
  // getAll() ベースのテストが過去ランの残骸に左右される（watches が実際に漏れていた）。
  const arrayFiles = [
    'users', 'orders', 'gpus', 'escrows', 'payments', 'reputations', 'verifications', 'uptime', 'watches',
    // createJsonRepository 経由ではないが data/ に書く独自ストア
    'sandbox-apikeys', // src/api/sandbox-apikey.js — 配列に追記型
  ];
  const objectFiles = ['revoked-tokens', 'notification-settings'];
  // 配列/オブジェクト空でもない独自初期形状を持つファイル。
  // sla-tracker の loadSLA() が期待する { total, up, down, history } と同一にする —
  // '[]' や '{}' でリセットすると sla.history.push が TypeError で監視がクラッシュする。
  const defaultFiles = {
    'sla': { total: 0, up: 0, down: 0, history: [] },
  };

  // CI のクリーンチェックアウトには data/ ディレクトリ自体が存在しない
  // （data/*.json は未コミット）。ローカルでは常に存在するため露見しなかったが、
  // ディレクトリなしで writeFileSync すると ENOENT で全スイートが起動前に死ぬ。
  fs.mkdirSync(DATA_DIR, { recursive: true });

  for (const name of arrayFiles) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), '[]', 'utf-8');
  }
  for (const name of objectFiles) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), '{}', 'utf-8');
  }
  for (const [name, value] of Object.entries(defaultFiles)) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(value), 'utf-8');
  }
};
