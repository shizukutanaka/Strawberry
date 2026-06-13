// Jest configuration
// testTimeout increased from default 5000ms because integration tests run against
// JSON data files that accumulate across test runs and can grow large.
// globalSetup resets data files before every run so they don't grow unboundedly.
module.exports = {
  testTimeout: 30000,
  globalSetup: './tests/globalSetup.js',
};
