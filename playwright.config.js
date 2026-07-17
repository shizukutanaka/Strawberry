// playwright.config.js — E2E test config for the public/ SPA.
// Runs against a real server instance (webServer below boots it) using real
// HTTP requests through a real browser — this is the layer jest's supertest-based
// suite doesn't cover: actual DOM rendering, CSP enforcement, and the SPA's own
// client-side routing/state logic in public/js/*.
const fs = require('fs');

// This sandbox pre-installs Chromium outside the usual Playwright cache and
// sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 so `npx playwright install` is a
// no-op. Point at it explicitly ONLY when it exists; on a normal dev machine
// or a real CI runner (where `npx playwright install` was run normally),
// this path won't exist and Playwright falls back to its own resolved browser.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || (fs.existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);

module.exports = {
  testDir: './tests/e2e',
  globalSetup: require.resolve('./tests/e2e/globalSetup.js'),
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: false, // shares the JSON data layer with a single running server; see jest.config.js's own note on cross-worker races
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3010',
    launchOptions: executablePath ? { executablePath } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'node src/api/server.js',
    url: 'http://localhost:3010/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
    env: {
      NODE_ENV: 'test', // bypasses the production rate limiter (see src/api/middleware/security.js apiLimiter) so a full E2E run doesn't 429 itself
      PORT: '3010', // isolated from the port a developer might already have `npm start` running on
    },
  },
};
