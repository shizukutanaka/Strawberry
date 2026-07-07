// tests/globalSetup.js — Jest globalSetup
// Reset JSON data files before each test run to prevent unbounded accumulation
// that would slow down getAll() calls as the suite grows over time.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');

module.exports = async function globalSetup() {
  const arrayFiles = ['users', 'orders', 'gpus', 'escrows', 'payments', 'reputations', 'verifications'];
  const objectFiles = ['revoked-tokens', 'notification-settings'];

  for (const name of arrayFiles) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), '[]', 'utf-8');
  }
  for (const name of objectFiles) {
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), '{}', 'utf-8');
  }
};
