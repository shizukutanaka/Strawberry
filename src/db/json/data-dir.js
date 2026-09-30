// src/db/json/data-dir.js
// data/ ディレクトリ解決の単一 chokepoint。
// STRAWBERRY_DATA_DIR で明示上書き可能（永続ボリュームのマウント先など）。
// Jest ワーカー内では JEST_WORKER_ID ごとの専用 dir (data-test/worker-N) を
// 返す: JSON リポジトリは共有ファイルを同期 I/O するため同じ data/ を全
// ワーカーで共有すると maxWorkers>1 でロストアップデート競合が起きる
// （同じ配列を load→push→atomicWrite する2ワーカーが互いの行を潰す）。
// ワーカー別 dir によりスイート並列化を可能にする。ワーカー dir へのシードは
// setupFiles (tests/setupWorkerData.js) がワーカー起動ごとに行う —
// globalSetup はワーカー生成前の単一プロセスでしか動かず JEST_WORKER_ID も
// 未設定のため、各ワーカー dir をそこで初期化することはできない。
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');

function resolveDataDir() {
  if (process.env.STRAWBERRY_DATA_DIR) {
    return path.resolve(process.env.STRAWBERRY_DATA_DIR);
  }
  if (process.env.JEST_WORKER_ID) {
    return path.join(REPO_ROOT, 'data-test', `worker-${process.env.JEST_WORKER_ID}`);
  }
  return path.join(REPO_ROOT, 'data');
}

module.exports = { resolveDataDir };
