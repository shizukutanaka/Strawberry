// Jest configuration
// testTimeout increased from default 5000ms because integration tests run against
// JSON data files that accumulate across test runs and can grow large.
// globalSetup resets data files before every run so they don't grow unboundedly.
//
// maxWorkers: 各 Jest ワーカーは専用のデータ dir (data-test/worker-N,
// src/db/json/data-dir.js 参照) を持つため、共有 data/*.json をめぐる
// ロストアップデート競合は解消済み。'50%' で CPU コア数に応じて並列化し
// スイートの wall-clock を短縮する。globalSetup は従来どおり data/ を
// リセットしつつ data-test/ を一括除去し、ワーカー dir のシードは
// setupFiles (tests/setupWorkerData.js) が各ワーカーで行う。
module.exports = {
  testTimeout: 30000,
  globalSetup: './tests/globalSetup.js',
  setupFiles: ['./tests/setupWorkerData.js'],
  maxWorkers: '50%',
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
