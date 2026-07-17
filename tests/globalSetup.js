// tests/globalSetup.js — Jest globalSetup
// Reset JSON data files before each test run to prevent unbounded accumulation
// that would slow down getAll() calls as the suite grows over time.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');

module.exports = async function globalSetup() {
  const arrayFiles = ['users', 'orders', 'gpus', 'escrows', 'payments', 'reputations', 'verifications', 'uptime'];
  const objectFiles = ['revoked-tokens', 'notification-settings'];

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
};
