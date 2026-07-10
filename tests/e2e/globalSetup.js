// tests/e2e/globalSetup.js — Playwright globalSetup, mirroring tests/globalSetup.js
// (jest's own reset) for the same reason: without it, data/*.json accumulates
// across the whole E2E run (the webServer stays up for every test file, unlike
// jest's per-suite isolation), so a later test's "the queue is now empty"
// assertion can see leftover rows from an earlier, unrelated test.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');

module.exports = async function globalSetup() {
  const arrayFiles = ['users', 'orders', 'gpus', 'escrows', 'payments', 'reputations', 'verifications', 'watches'];
  const objectFiles = ['revoked-tokens', 'notification-settings'];

  for (const name of arrayFiles) {
    const filePath = path.join(DATA_DIR, `${name}.json`);
    if (fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]', 'utf-8');
  }
  for (const name of objectFiles) {
    const filePath = path.join(DATA_DIR, `${name}.json`);
    if (fs.existsSync(filePath)) fs.writeFileSync(filePath, '{}', 'utf-8');
  }
};
