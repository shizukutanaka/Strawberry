#!/usr/bin/env node
// scripts/report-audit-backlog.js — npm audit の積存レポート (i22)
//
// `npm audit --json` を実行し、残存脆弱性を severity × 修正可否
// (semver 範囲内の audit fix あり / breaking 必須 / 経路依存) で集計する。
// 情報のみ — 終了コードは常に 0（未検査項目のスキャン基盤差異で false-positive
// させないため、運用判断はレポート本文を見て行う）。
//
// 使い方:
//   node scripts/report-audit-backlog.js          人間可読レポート
//   node scripts/report-audit-backlog.js --json   機械可読 JSON
//
// 設計ノート:
// - npm audit はレジストリ経由で advisory DB に問い合わせるため、
//   オフライン/ミラー環境では実行失敗する — 失敗も 0 で静黙報告する。
// - npm v7+ の JSON 形式 (vulnerabilities ツリー) を対象にする。
//   via は文字列（名前参照）とオブジェクト（advisory）が混在する。

const { execFileSync } = require('child_process');

const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];

function collectAudit() {
  let stdout;
  try {
    stdout = execFileSync('npm', ['audit', '--json', '--omit', 'dev'], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_UPDATE_NOTIFIER: '1' },
    });
  } catch (e) {
    // npm audit は脆弱性検出時も exit 1 を返す — stdout があれば結果あり。
    if (e.stdout && e.stdout.trim()) {
      stdout = e.stdout;
    } else {
      return { error: e.message.split('\n')[0] };
    }
  }
  try {
    return JSON.parse(stdout);
  } catch (e) {
    return { error: `npm audit JSON パース失敗: ${e.message}` };
  }
}

function summarizeVulns(audit) {
  const vulns = audit.vulnerabilities || {};
  const rows = [];
  const bySeverity = {};
  for (const s of SEVERITIES) bySeverity[s] = { count: 0, fixable: 0 };

  for (const [pkg, v] of Object.entries(vulns)) {
    if (!v || typeof v !== 'object') continue;
    const severity = SEVERITIES.includes(v.severity) ? v.severity : 'info';
    // fixAvailable: true（semver 内 fix あり）/ オブジェクト（name+version =
    // メジャー更新を含む fix）/ false（直接 fix なし — 経路 fix のみ）
    const semverFix = v.fixAvailable === true;
    const breaking = v.fixAvailable && typeof v.fixAvailable === 'object';
    const fixable = semverFix || breaking;
    bySeverity[severity].count++;
    if (semverFix) bySeverity[severity].fixable++;
    // via のうち advisory オブジェクトのタイトルを列挙（件数把握用、文字列 via は
    // 推移的依存参照なのでタイトルなし）
    const titles = (Array.isArray(v.via) ? v.via : [])
      .filter((x) => x && typeof x === 'object' && x.title)
      .map((x) => x.title)
      .slice(0, 3);
    rows.push({
      package: pkg,
      severity,
      fixable: semverFix,
      breaking: !!breaking,
      direct: v.isDirect === true,
      advisories: titles,
    });
  }
  rows.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return { rows, bySeverity, total: rows.length };
}

function main() {
  const jsonMode = process.argv.includes('--json');
  const audit = collectAudit();
  if (audit.error) {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: audit.error }));
    } else {
      console.log(`[report-audit-backlog] npm audit 実行失敗: ${audit.error}`);
    }
    return;
  }
  const report = summarizeVulns(audit);
  const meta = audit.metadata && audit.metadata.vulnerabilities ? audit.metadata.vulnerabilities : {};
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, total: report.total, bySeverity: report.bySeverity, metadata: meta, packages: report.rows }, null, 2));
    return;
  }
  console.log('[report-audit-backlog]');
  console.log(`  total: ${report.total} vulnerable dependency chain(s)`);
  for (const s of SEVERITIES) {
    const b = report.bySeverity[s];
    if (b.count === 0) continue;
    console.log(`  ${s}: ${b.count} (semver-fixable: ${b.fixable})`);
  }
  const fixable = report.rows.filter((r) => r.fixable);
  const breaking = report.rows.filter((r) => r.breaking);
  const unfixable = report.rows.filter((r) => !r.fixable && !r.breaking);
  if (fixable.length) {
    console.log(`\n  semver 内で修正可 (${fixable.length}) → \`npm audit fix\` で対応可能:`);
    for (const r of fixable.slice(0, 15)) console.log(`    - ${r.package} [${r.severity}]${r.direct ? ' (direct)' : ''}`);
    if (fixable.length > 15) console.log(`    ... 他 ${fixable.length - 15} 件`);
  }
  if (breaking.length) {
    console.log(`\n  メジャー更新を含む fix (${breaking.length}) → 互換性確認のうえ更新:`);
    for (const r of breaking.slice(0, 15)) console.log(`    - ${r.package} [${r.severity}]${r.direct ? ' (direct)' : ''}`);
    if (breaking.length > 15) console.log(`    ... 他 ${breaking.length - 15} 件`);
  }
  if (unfixable.length) {
    console.log(`\n  直接 fix なし・経路 fix のみ (${unfixable.length}) → 上位依存の更新または依存置換が必要:`);
    for (const r of unfixable.slice(0, 15)) console.log(`    - ${r.package} [${r.severity}]${r.direct ? ' (direct)' : ''}`);
    if (unfixable.length > 15) console.log(`    ... 他 ${unfixable.length - 15} 件`);
  }
  if (report.total === 0) console.log('  脆弱性なし');
}

if (require.main === module) {
  main();
}

module.exports = { collectAudit, summarizeVulns };
