#!/usr/bin/env node
// scripts/report-test-counts.js — jest の実測スイート/テスト数を取得し、
// ドキュメントに書かれたテスト数記述とのズレ（陳腐化）を検出するレポーター。
//
// 使い方: node scripts/report-test-counts.js
//   --update     : 検出したズレをドキュメント上で置き換えて書き戻す（既定は報告のみ）
//
// 背景: PRODUCT_ANALYSIS.md 等の「N スイート・N テスト」記述は手動同期のため
// 陳腐化しやすい（#266 で実測同期が必要だった）。このスクリプトは
// (1) jest --listTests で実測スイート数、
// (2) tests/ 内の it(/test( 呼び出し回数で近似テスト数
// を測り、ドキュメント中の数値記述との差を表示する。差があるだけでは
// exit 1 にはしない（docs 陳腐化は情報通知の性質のため）。
//
// 注意: テスト数は it.each の展開ケースを数えられない近似値。
// 正確な数は `npx jest` フル実行のサマリを参照のこと。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
const DOC_FILES = ['README.md', 'docs/PRODUCT_ANALYSIS.md'];

function listTestFiles() {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'e2e' || ent.name === 'fixtures' || ent.name.startsWith('.')) continue;
        walk(p);
      } else if (/\.test\.(js|ts)$/.test(ent.name)) {
        out.push(p);
      }
    }
  };
  walk(TESTS_DIR);
  return out;
}

function countTestCalls(files) {
  // it( / test( / xit( / it.each(...) / describe.each 内の it —
  // コメント・文字列内の偽陽性を減らすため行頭寄りの呼び出し形のみ数える。
  const re = /(^|\s)(x?it|x?test)\s*(\.\w+)?\s*\(/g;
  let n = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const m = src.match(re);
    if (m) n += m.length;
  }
  return n;
}

function measuredSuites() {
  // jest --listTests はテストファイルを列挙する（実行しない）。e2e は
  // jest.config の testMatch から除外済み。タイムアウトつきで実行。
  const stdout = execFileSync('npx', ['jest', '--listTests'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, CI: '1' },
  });
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean).length;
}

function docClaims(file) {
  // 「247 スイート」「1,982 テスト」「255 件」等の記述を拾う。
  // 「件」単位はテスト件数以外の記述と混ざるため、直前60文字に「テスト」を
  // 含む場合に限定する（「不足機能44件」の誤爆を避ける）。
  const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const claims = [];
  const push = (m, value, unit) => {
    const lineStart = src.lastIndexOf('\n', m) + 1;
    const lineEnd = src.indexOf('\n', m);
    claims.push({ file, value, unit, context: src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd).trim() });
  };
  let m;
  const direct = /([0-9][0-9,]*)\s*(スイート|テスト|suites?|tests?)/g;
  while ((m = direct.exec(src)) !== null) {
    push(m.index, parseInt(m[1].replace(/,/g, ''), 10), m[2]);
  }
  const ken = /テスト[^\n]{0,60}?([0-9][0-9,]*)\s*件/g;
  while ((m = ken.exec(src)) !== null) {
    push(m.index, parseInt(m[1].replace(/,/g, ''), 10), 'テスト');
  }
  return claims;
}

function main() {
  const update = process.argv.includes('--update');
  const files = listTestFiles();
  const suites = measuredSuites();
  const testsApprox = countTestCalls(files);
  console.log(`measured: suites=${suites} (jest --listTests), tests≈${testsApprox} (it/test call sites — 近似値)`);

  const isSuite = (unit) => /suites?|スイート/i.test(unit);
  const claims = DOC_FILES.flatMap((f) => (fs.existsSync(path.join(REPO_ROOT, f)) ? docClaims(f) : []));
  let drift = 0;
  for (const c of claims) {
    if (isSuite(c.unit)) {
      // スイート数は正確値比較 — ±1 のずれも検出する
      if (c.value !== suites) {
        drift++;
        console.log(`  [drift] ${c.file}: "${c.value} ${c.unit}" (measured ${suites}) — ${c.context}`);
      }
      continue;
    }
    // テスト件数クレームは「現在の総数」を謳っているものだけ判定する。
    // 実測の 0.3〜3 倍の値域外（例: 歴史的サイクル数 116、部分スイート数 255）は
    // 現在総数の主張ではないのでスキップ。値域内で近似値と10%超ずれれば drift。
    if (c.value < testsApprox * 0.3 || c.value > testsApprox * 3) continue;
    const nearHit = Math.abs(c.value - testsApprox) <= Math.max(3, testsApprox * 0.1);
    if (!nearHit) {
      drift++;
      console.log(`  [drift] ${c.file}: "${c.value} ${c.unit}" — ...${c.context}`);
    }
  }
  console.log(drift === 0 ? 'doc claims: no drift' : `doc claims: ${drift} potential drift point(s)`);
  if (update && drift > 0) {
    console.log('(--update は数値の意味を区別できないため自動置換しません — 上記箇所を手動で同期してください)');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`report-test-counts: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { listTestFiles, countTestCalls, docClaims };
