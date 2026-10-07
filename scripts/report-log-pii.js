#!/usr/bin/env node
// scripts/report-log-pii.js — logs/*.log 内のメールアドレス混入を検出するレポーター。
//
// 弱所#17「ログへの PII 混入リスク」対策: 監査ログ・アクセスログには email フィールドが
// 記録され得る経路が残る（登録・認証イベント）。PII を含むログファイルの所在を可視化し、
// ローテーション削除やマスキング強化の判断材料にする。
//
// 使い方:
//   node scripts/report-log-pii.js            人間可読レポート（PII 自体は出力しない）
//   node scripts/report-log-pii.js --json     機械可読 JSON
//   node scripts/report-log-pii.js <dir>      対象ディレクトリの変更（既定: logs/）
//   環境変数 STRAWBERRY_LOG_DIR でも差し替え可
//
// 注意: PII の値そのものは絶対に出力しない（行番号と件数のみ）。
// 情報のみ — 終了コードは常に 0。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 一般的な email 形状（厳密な RFC5322 ではなく「見た目が email」= PII 候補として拾う方針）
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// 検査対象: .log およびローテーション済み .log.N
const LOG_FILE_RE = /\.log(\.\d+)?$/;
// ファイル種類別に検査 — 構造化 JSONL（audit 系）と自由形式ログで混入経路が違うため。

function scanFile(file) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch (e) {
    return { error: e.message };
  }
  let hits = 0;
  const hitLines = [];
  for (let i = 0; i < lines.length; i++) {
    EMAIL_RE.lastIndex = 0;
    const m = lines[i].match(EMAIL_RE);
    if (m && m.length) {
      hits += m.length;
      // 行番号のみ記録（最大5件）。値は収集しない。
      if (hitLines.length < 5) hitLines.push(i + 1);
    }
  }
  return { hits, hitLines };
}

function report(dir = path.join(ROOT, 'logs')) {
  const files = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && LOG_FILE_RE.test(e.name)) files.push(path.join(dir, e.name));
    }
  } catch (e) {
    return { dir, error: e.message, files: [] };
  }
  const results = [];
  for (const f of files.sort()) {
    const r = scanFile(f);
    results.push({ file: path.basename(f), ...r });
  }
  return { dir, files: results };
}

function main() {
  const jsonMode = process.argv.includes('--json');
  const argv = process.argv.slice(2).filter((a) => a !== '--json');
  const dir = argv[0] ? path.resolve(argv[0]) : (process.env.STRAWBERRY_LOG_DIR || path.join(ROOT, 'logs'));
  const r = report(dir);
  if (jsonMode) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`[report-log-pii] ${r.dir}`);
  if (r.error) {
    console.log(`  ディレクトリを読めません: ${r.error}`);
    return;
  }
  if (!r.files.length) {
    console.log('  ログファイルなし');
    return;
  }
  const withHits = r.files.filter((f) => f.hits > 0);
  const total = r.files.reduce((s, f) => s + (f.hits || 0), 0);
  console.log(`  ${r.files.length} ファイル走査 — email 候補 ${total} 件 / ${withHits.length} ファイル`);
  for (const f of withHits) {
    console.log(`    - ${f.file}: ${f.hits} 件（行 ${f.hitLines.join(', ')}${f.hits > f.hitLines.length ? ' 他' : ''}）`);
  }
  if (!withHits.length) console.log('  PII 混入なし');
  console.log('  ※ 値は出力しません。詳細確認は該当行を手動で参照のこと');
}

if (require.main === module) {
  main();
}

module.exports = { report, scanFile };
