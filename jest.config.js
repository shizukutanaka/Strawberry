// Jest configuration
// testTimeout increased from default 5000ms because integration tests run against
// JSON data files that accumulate across test runs and can grow large.
// globalSetup resets data files before every run so they don't grow unboundedly.
//
// maxWorkers: 1 — run suites serially. The JSON data layer (src/db/json/*) and a
// few modules read/write shared files under data/ (users.json, orders.json,
// escrows.json, …). Parallel jest workers race on those files: two workers load
// the same array, append different rows, and the second write clobbers the
// first's row — surfacing as non-deterministic failures that move between suites
// run to run (a user that "vanishes" before login, an escrow that isn't found).
// Serial execution makes the suite deterministic. The correct long-term fix is
// per-worker data isolation (a configurable data dir keyed by JEST_WORKER_ID);
// until then, reliability is worth the slower wall-clock time.
module.exports = {
  testTimeout: 30000,
  globalSetup: './tests/globalSetup.js',
  maxWorkers: 1,
  // test-coverage-check.yml の閾値チェックは coverage/coverage-summary.json を
  // 読むが、既定 reporters (json/lcov/text/clover) は json-summary を出力せず
  // ジョブが MODULE_NOT_FOUND で落ちていた。json-summary を追加して修正。
  coverageReporters: ['json', 'json-summary', 'lcov', 'text', 'clover'],
  // CI で実行不能な経路しか持たないファイルを計測対象から除外する。
  // collectCoverageFrom ではなく coveragePathIgnorePatterns を使う理由:
  // 前者を書くと既定の「テストが実際にロードしたファイル」計測から
  // 「全 .js ファイル走査」に変わり、未ロードの大量のファイル（public/ の
  // フロントエンド、ops スクリプト群など）が 0% として混入してしまう。
  // こちらは既定の計測集合を保ったまま該当ファイルだけを除く。
  //   p2p-network.js           … libp2p（optional・未導入）が必要でロード不可
  //   virtual-gpu-manager.js   … Docker/k8s/GPU 実機が前提
  //   gpu-detector-extended.js … 実 GPU（nvidia-smi/rocm）が前提
  // この3ファイルだけで計 737 行が CI 上で永遠にカバー不能。
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/p2p-network\\.js$',
    '/virtual-gpu-manager\\.js$',
    '/gpu-detector-extended\\.js$',
  ],
  // tests/e2e/* are Playwright specs (run via `npm run test:e2e`), not Jest.
  // Playwright's test.describe throws if invoked inside Jest, so exclude that
  // directory here — otherwise a full `npm test` run reports its spec files as
  // failed suites even though they pass under Playwright.
  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/'],
};
