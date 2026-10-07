#!/usr/bin/env node
// scripts/report-console-usage.js — src/ 内の console.* 直書き残存を棚卸するレポーター。
//
// 弱所#45「構造化ログの不統一」対策: ロガー規約（utils/logger）を迂回した
// console.log/error/warn が残ると、ログレベル・構造化フィールド・ローテーションの
// 恩恵を受けられない出力が紛れ込む。所在を計量化して整理の判断材料にする。
//
// 使い方:
//   node scripts/report-console-usage.js            人間可読レポート
//   node scripts/report-console-usage.js --json     機械可読 JSON
//
// 情報のみ — 終了コードは常に 0。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CONSOLE_RE = /\bconsole\.(log|error|warn|info|debug)\b/g;

// console 出力が正当なファイル（CLI 標準出力、ロガー実装・そのフォールバック）
const LEGIT = new Set([
  'cli.js',
  path.join('utils', 'logger.js'),
  path.join('core', 'logger.js'),
  path.join('utils', 'audit-log.js'), // 監査ログ書込失敗時の最終フォールバック
]);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.js')) yield p;
  }
}

function countInFile(file) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { error: e.message };
  }
  const byKind = {};
  let total = 0;
  for (const m of src.matchAll(CONSOLE_RE)) {
    byKind[m[1]] = (byKind[m[1]] || 0) + 1;
    total++;
  }
  return { total, byKind };
}

function report() {
  const files = [];
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f);
    const r = countInFile(f);
    if (r.error) {
      files.push({ file: rel, error: r.error });
      continue;
    }
    if (!r.total) continue;
    files.push({ file: rel, count: r.total, byKind: r.byKind, legit: LEGIT.has(rel) });
  }
  files.sort((a, b) => (b.count || 0) - (a.count || 0));
  const drift = files.filter((f) => !f.legit);
  return {
    files,
    summary: {
      filesWithConsole: files.length,
      legitFiles: files.filter((f) => f.legit).length,
      driftFiles: drift.length,
      driftCalls: drift.reduce((s, f) => s + (f.count || 0), 0),
    },
  };
}

function main() {
  const jsonMode = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  const r = report();
  if (jsonMode) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    const s = r.summary;
    console.log(`[report-console-usage] src/ の console.* 使用: ${s.filesWithConsole} ファイル（正当 ${s.legitFiles} / drift ${s.driftFiles}・${s.driftCalls} 呼出）`);
    for (const f of r.files) {
      if (f.error) {
        console.log(`    ! ${f.file}: 読込不可 ${f.error}`);
        continue;
      }
      const kinds = Object.entries(f.byKind).map(([k, n]) => `${k}×${n}`).join(' ');
      console.log(`    ${f.legit ? '=' : '-'} ${f.file}: ${f.count}（${kinds}）${f.legit ? ' [正当: CLI/ロガー実装]' : ''}`);
    }
    if (!s.driftFiles) console.log('  ロガー迂回 drift なし');
  }
  if (strict && r.summary.driftFiles > 0) {
    console.error(`report-console-usage: ${r.summary.driftFiles} ファイルのロガー迂回 drift を検出`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { report };
