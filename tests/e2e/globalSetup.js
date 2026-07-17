// tests/e2e/globalSetup.js — Playwright globalSetup, mirroring tests/globalSetup.js
// (jest's own reset) for the same reason: without it, data/*.json accumulates
// across the whole E2E run (the webServer stays up for every test file, unlike
// jest's per-suite isolation), so a later test's "the queue is now empty"
// assertion can see leftover rows from an earlier, unrelated test.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');

module.exports = async function globalSetup() {
  const arrayFiles = ['users', 'orders', 'gpus', 'escrows', 'payments', 'reputations', 'verifications', 'watches', 'uptime'];
  const objectFiles = ['revoked-tokens', 'notification-settings'];

  // クリーンチェックアウト（CI 等）には data/ が無いため作成する。以前は
  // existsSync ガードで「無ければスキップ」していたが、それだと data/ が空の
  // 環境で前回実行分のリセットが行われず決定性が崩れる。jest 側（tests/globalSetup.js）
  // と同じく無条件で書き出し、確実に空状態から始める。
  fs.mkdirSync(DATA_DIR, { recursive: true });

  for (const name of arrayFiles) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), '[]', 'utf-8');
  }
  for (const name of objectFiles) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), '{}', 'utf-8');
  }
};
