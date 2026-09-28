// tests/globalSetup.js — Jest globalSetup
// 前回実行のワーカー別データ dir (data-test/worker-N) を一括除去する。
// ワーカーは resolveDataDir() で data-test/worker-N を使い、シードは
// setupFiles (tests/setupWorkerData.js) がファイル単位で行うため、
// ここでは実 data/ には一切触れない — live の users/orders/payments 等を
// `[]` へリセットすると開発者の既存レコードを npm test 実行ごとに破壊する。
const fs = require('fs');
const path = require('path');

// Jest ワーカー別データ dir のルート（src/db/json/data-dir.js 参照）。
const TEST_DATA_ROOT = path.join(__dirname, '../data-test');

module.exports = async function globalSetup() {
  // ここはワーカー生成前の単一プロセスなので削除しても走行中のワーカーと競合しない。
  fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
};
