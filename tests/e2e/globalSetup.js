// tests/e2e/globalSetup.js — Playwright globalSetup
// webServer が全テストで共有するため data/*.json を空へリセットして
// 決定性を確保するが、リセット前に既存内容を data/.e2e-snapshot へ退避する。
// globalTeardown (tests/e2e/globalTeardown.js) が実行後に復元するため、
// 開発者の live データ（users/orders/payments 等）を npm run test:e2e が
// 破壊しない。前回実行がクラッシュして snapshot が残っていれば先に復元する。
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const SNAPSHOT_DIR = path.join(DATA_DIR, '.e2e-snapshot');

const ARRAY_FILES = ['users', 'orders', 'gpus', 'escrows', 'payments', 'reputations', 'verifications', 'watches', 'uptime', 'sandbox-apikeys'];
const OBJECT_FILES = ['revoked-tokens', 'notification-settings'];
// 配列/空オブジェクト以外の初期形状を持つシード
const DEFAULT_FILES = {
  'sla': { total: 0, up: 0, down: 0, history: [] },
};
const SEED_FILES = [...ARRAY_FILES, ...OBJECT_FILES, ...Object.keys(DEFAULT_FILES)];

function restoreSnapshot() {
  const manifestPath = path.join(SNAPSHOT_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  for (const name of SEED_FILES) {
    const target = path.join(DATA_DIR, `${name}.json`);
    const backup = path.join(SNAPSHOT_DIR, `${name}.json`);
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, target);
    } else if (fs.existsSync(target)) {
      // 実行前に存在しなかったファイルは削除して実行前の状態へ戻す
      fs.unlinkSync(target);
    }
  }
  // 実行前に data/ 自体が無かった場合はディレクトリごと消して元通りにする
  fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  if (!manifest.dataDirExisted && fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  return true;
}

module.exports = async function globalSetup() {
  // 前回実行が teardown 前にクラッシュした場合、live データの退避が残っている。
  // 先に復元してから今回分の退避を取り直す（退避の上書き消失を防ぐ）。
  try {
    restoreSnapshot();
  } catch {
    // snapshot が破損していても復元失敗でセットアップ自体は止めない
    fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  }

  const dataDirExisted = fs.existsSync(DATA_DIR);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  for (const name of SEED_FILES) {
    const target = path.join(DATA_DIR, `${name}.json`);
    if (fs.existsSync(target)) {
      fs.copyFileSync(target, path.join(SNAPSHOT_DIR, `${name}.json`));
    }
  }
  fs.writeFileSync(
    path.join(SNAPSHOT_DIR, 'manifest.json'),
    JSON.stringify({ dataDirExisted }, null, 0),
    'utf-8'
  );

  for (const name of ARRAY_FILES) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), '[]', 'utf-8');
  }
  for (const name of OBJECT_FILES) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), '{}', 'utf-8');
  }
  for (const [name, value] of Object.entries(DEFAULT_FILES)) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(value), 'utf-8');
  }
};

module.exports._private = { restoreSnapshot, DATA_DIR, SNAPSHOT_DIR, SEED_FILES };
