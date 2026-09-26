// tests/setupWorkerData.js — Jest setupFiles
// 各テストファイル実行前に、そのワーカー専用のデータ dir
// (resolveDataDir() → data-test/worker-N) をシードする。
// globalSetup.js と同一のリセット内容をこちらへ適用する理由:
// globalSetup はワーカー生成前の単一プロセスで動き JEST_WORKER_ID も未設定
// なので、ワーカー別 dir の初期化は per-file の setupFiles でしか行えない。
const fs = require('fs');
const path = require('path');
const { resolveDataDir } = require('../src/db/json/data-dir');

const DATA_DIR = resolveDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });

for (const name of ['users', 'orders', 'gpus', 'escrows', 'payments', 'reputations', 'verifications', 'uptime']) {
  fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), '[]', 'utf-8');
}
for (const name of ['revoked-tokens', 'notification-settings']) {
  fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), '{}', 'utf-8');
}
