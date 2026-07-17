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
  // tests/e2e/* are Playwright specs (run via `npm run test:e2e`), not Jest.
  // Playwright's test.describe throws if invoked inside Jest, so exclude that
  // directory here — otherwise a full `npm test` run reports its spec files as
  // failed suites even though they pass under Playwright.
  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/'],
};
