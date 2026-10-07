#!/usr/bin/env node
// scripts/report-env-drift.js — コード内 process.env 参照と .env.example の差分検出
//
// 新しい env 変数を追加しても .env.example への記載を忘れやすい（運用者が
// 変数の存在を知る唯一の導線が .env.example のため、記載漏れ = 実質未定義）。
// これまで #55/#138/#240 で手動同期が繰り返されてきた drift を機械検出する。
//
// 使い方:
//   node scripts/report-env-drift.js          人間可読レポート
//   node scripts/report-env-drift.js --json   機械可読 JSON
//
// 情報のみ — 終了コードは常に 0。検出対象は src/ と scripts/ 直下再帰の
// process.env.NAME 参照（動的アクセス env[name] は対象外 — 解決不能なので
// 誤検知よりも検出しない方が安全）。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'scripts'];
// ルート直下の *.js（lightning-service.js / virtual-gpu-manager.js /
// gpu_lending_setup_auto_register.js 等の起動・ツール系エントリ）も
// スキャン対象 — src/ 外にあるため drift 検出をすり抜けていた。
const ROOT_JS = true;
// unreferenced 判定の haystack は tests/ も含める — テスト専用変数
// （E2E_BASE_URL 等）を「どこにも使われていない」と誤検しないため。
const HAYSTACK_DIRS = ['src', 'scripts', 'tests'];
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
// コードにしか存在しないことを前提とする変数（実行環境が供給する組み込み系）。
const BUILTIN_IGNORE = new Set([
  'NODE_ENV', 'PATH', 'HOME', 'PWD', 'PORT', 'HOSTNAME', 'CI', 'JEST_WORKER_ID',
  'npm_lifecycle_event', 'npm_config_user_agent', 'LANG', 'TZ',
  // Docker / Kubernetes がコンテナ内へ自動注入する環境変数
  'DOCKER_HOST', 'KUBERNETES_SERVICE_HOST',
]);

const ENV_RE = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
// process.env.NAME に加えて、env=process.env を受けるヘルパー経由の env.NAME と
// ブラケット記法 process.env['NAME'] も参照として拾う。
const ENV_DOT_RE = /\benv\.([A-Z_][A-Z0-9_]*)/g;
const ENV_BRACKET_RE = /process\.env\[['"`]([A-Z_][A-Z0-9_]*)['"`]\]/g;

function* walkJs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      yield* walkJs(p);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      yield p;
    }
  }
}

// コードが参照する env 変数 → 参照箇所（file:line）の一覧。
// contentMap は unreferenced 判定用にファイル全文も返す。
function referencedVars(root = ROOT) {
  const refs = new Map();
  const contents = [];
  const record = (name, loc) => {
    if (!refs.has(name)) refs.set(name, []);
    refs.get(name).push(loc);
  };
  const files = [];
  for (const base of HAYSTACK_DIRS) {
    for (const file of walkJs(path.join(root, base))) files.push(file);
  }
  if (ROOT_JS) {
    // ルート直下 *.js（walkJs はディレクトリ前提なので個別列挙）も対象
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.js')) files.push(path.join(root, e.name));
    }
  }
  for (const file of files) {
    const rel = path.relative(root, file);
    const src = fs.readFileSync(file, 'utf8');
    contents.push(src);
    // tests/ は haystack のみ — 参照としては記録しない
    if (rel.startsWith('tests' + path.sep)) continue;
    src.split('\n').forEach((line, i) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return; // コメント行は参照でない
      const loc = `${rel}:${i + 1}`;
      for (const re of [ENV_RE, ENV_DOT_RE, ENV_BRACKET_RE]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) record(m[1], loc);
      }
    });
  }
  return { refs, contents };
}

// .env.example に記載のある変数名（`NAME=` と `# NAME=` コメントアウト行の両方。
// コメントアウト例も「記載済み」と見なす — 任意設定の書き方規約）。
function documentedVars(envExamplePath = ENV_EXAMPLE) {
  const documented = new Set();
  const duplicates = new Set();
  const raw = fs.readFileSync(envExamplePath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (m) {
      if (documented.has(m[1])) duplicates.add(m[1]);
      documented.add(m[1]);
    }
  }
  return { documented, duplicates };
}

function report(root = ROOT, envExamplePath = ENV_EXAMPLE) {
  const { refs, contents } = referencedVars(root);
  const haystack = contents.join('\n');
  const { documented, duplicates } = documentedVars(envExamplePath);
  const undocumented = [...refs.entries()]
    .filter(([name]) => !documented.has(name) && !BUILTIN_IGNORE.has(name))
    .map(([name, locs]) => ({ name, references: locs.slice(0, 5) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // 「記載のみで未参照」は文字列としてコード内に一切出ない場合のみ報告する。
  // safeInt('NAME') 等の文字列引数経由や tests/・設定ファイル経由の参照を
  // 誤って陳腐化扱いしないため、単純な部分文字列で判定する。
  const unreferenced = [...documented]
    .filter((name) => !haystack.includes(name))
    .sort();
  return {
    referenced: refs.size,
    documented: documented.size,
    undocumented,
    unreferenced,
    // .env.example 内の重複記載 — マージ残骸や陳腐化した二重定義の兆候
    duplicates: [...duplicates].sort(),
  };
}

function main() {
  const jsonMode = process.argv.includes('--json');
  const r = report();
  if (jsonMode) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log('[report-env-drift]');
  console.log(`  code references: ${r.referenced} / .env.example documented: ${r.documented}`);
  if (r.undocumented.length) {
    console.log(`\n  [drift] .env.example 未記載 (${r.undocumented.length}) — 運用者が存在を知れない変数:`);
    for (const u of r.undocumented) {
      console.log(`    - ${u.name}  (${u.references.join(', ')})`);
    }
  }
  if (r.unreferenced.length) {
    console.log(`\n  [info] .env.example 記載のみでコード未参照 (${r.unreferenced.length}) — ops スクリプト専用か陳腐化の可能性:`);
    for (const n of r.unreferenced.slice(0, 20)) console.log(`    - ${n}`);
    if (r.unreferenced.length > 20) console.log(`    ... 他 ${r.unreferenced.length - 20} 件`);
  }
  if (r.duplicates.length) {
    console.log(`\n  [info] .env.example 内の重複記載 (${r.duplicates.length}) — マージ残骸や二重定義:`);
    for (const n of r.duplicates) console.log(`    - ${n}`);
  }
  if (!r.undocumented.length && !r.unreferenced.length && !r.duplicates.length) {
    console.log('  drift なし');
  }
}

if (require.main === module) {
  main();
}

module.exports = { referencedVars, documentedVars, report };
