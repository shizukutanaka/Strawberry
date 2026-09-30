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
  // tests/e2e/* are Playwright specs (run via `npm run test:e2e`), not Jest.
  // Playwright's test.describe throws if invoked inside Jest, so exclude that
  // directory here — otherwise a full `npm test` run reports its spec files as
  // failed suites even though they pass under Playwright.
  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/'],
};
