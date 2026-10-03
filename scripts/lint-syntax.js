#!/usr/bin/env node
// ゼロ依存の構文リンチ: リポジトリ内の全 .js を `node --check` で検証する。
// eslint は依存に含まれないため、CI の `npm run lint` が実際に検査する最小構成として提供。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'data', 'data-test', 'backups', 'coverage',
  'build', 'dist', '.next', 'logs', 'playwright-report', 'test-results',
]);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(p);
    } else if (entry.name.endsWith('.js')) {
      yield p;
    }
  }
}

const failures = [];
let checked = 0;
for (const file of walk(ROOT)) {
  checked++;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    failures.push({ file: path.relative(ROOT, file), message: String(err.stderr || err.message).trim().split('\n')[0] });
  }
}

for (const f of failures) {
  console.error(`FAIL ${f.file}: ${f.message}`);
}
console.log(`lint-syntax: ${checked} files checked, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
