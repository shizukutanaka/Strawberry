#!/usr/bin/env node
// scripts/report-log-pii.js — logs/*.log 内のメールアドレス・資格情報混入を検出するレポーター。
//
// 弱所#17「ログへの PII 混入リスク」対策: 監査ログ・アクセスログには email フィールドが
// 記録され得る経路が残る（登録・認証イベント）。加えて JWT/Bearer トークンや apiKey 風の
// 資格情報は、漏洩すれば email より重大（そのまま認証を通る）ため同一ツールで検査する。
// PII/資格情報を含むログファイルの所在を可視化し、ローテーション削除や
// マスキング強化の判断材料にする。
//
// 使い方:
//   node scripts/report-log-pii.js            人間可読レポート（PII 自体は出力しない）
//   node scripts/report-log-pii.js --json     機械可読 JSON
//   node scripts/report-log-pii.js --strict   資格情報クラス（jwt/bearer/apikey）の混入で exit 1
//   node scripts/report-log-pii.js <dir>      対象ディレクトリの変更（既定: logs/）
//   環境変数 STRAWBERRY_LOG_DIR でも差し替え可
//
// 注意: PII の値そのものは絶対に出力しない（行番号と件数のみ）。
// --strict は資格情報クラスのみ失敗にする — email はテスト fixture（u1@example.com 等）や
// 監査イベントで正当に現れ得るため情報扱いのまま。CI のゲートは資格情報のみが対象。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 一般的な email 形状（厳密な RFC5322 ではなく「見た目が email」= PII 候補として拾う方針）
// 検出パターン: 各クラスを個別集計する（「どの種類の機密がどこに」が処置を左右する）。
// - email: PII 本体
// - jwt: eyJ で始まる3部トークン。ログに残ると再利用で認証を通る可能性
// - bearer: Authorization ヘッダ等の Bearer トークン
// - apikey: sk-/api_key= 系の生キー
const PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  jwt: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  bearer: /Bearer\s+[A-Za-z0-9._~+\/-]{16,}/gi,
  apikey: /\bsk[-_][A-Za-z0-9_-]{12,}\b|\bapi[_-]?key['"\s:=]+[A-Za-z0-9_-]{12,}/gi,
};
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
  const byKind = {};
  let hits = 0;
  const hitLines = [];
  for (let i = 0; i < lines.length; i++) {
    let lineHit = false;
    for (const [kind, re] of Object.entries(PATTERNS)) {
      re.lastIndex = 0;
      const m = lines[i].match(re);
      if (m && m.length) {
        byKind[kind] = (byKind[kind] || 0) + m.length;
        hits += m.length;
        lineHit = true;
      }
    }
    // 行番号のみ記録（最大5件）。値は収集しない。
    if (lineHit && hitLines.length < 5) hitLines.push(i + 1);
  }
  return { hits, hitLines, byKind };
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

// 資格情報クラスの種別 — --strict ゲートの対象。email は対象外（上記理由）。
const CREDENTIAL_KINDS = new Set(['jwt', 'bearer', 'apikey']);

function credentialHits(r) {
  return (r.files || []).reduce((s, f) => s + Object.entries(f.byKind || {})
    .filter(([k]) => CREDENTIAL_KINDS.has(k))
    .reduce((a, [, n]) => a + n, 0), 0);
}

function main() {
  const jsonMode = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  const argv = process.argv.slice(2).filter((a) => a !== '--json' && a !== '--strict');
  const dir = argv[0] ? path.resolve(argv[0]) : (process.env.STRAWBERRY_LOG_DIR || path.join(ROOT, 'logs'));
  const r = report(dir);
  if (jsonMode) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`[report-log-pii] ${r.dir}`);
    if (r.error) {
      console.log(`  ディレクトリを読めません: ${r.error}`);
    } else if (!r.files.length) {
      console.log('  ログファイルなし');
    } else {
      const withHits = r.files.filter((f) => f.hits > 0);
      const total = r.files.reduce((s, f) => s + (f.hits || 0), 0);
      console.log(`  ${r.files.length} ファイル走査 — PII/資格情報候補 ${total} 件 / ${withHits.length} ファイル`);
      for (const f of withHits) {
        const kinds = Object.entries(f.byKind || {}).map(([k, n]) => `${k}:${n}`).join(', ');
        console.log(`    - ${f.file}: ${f.hits} 件（${kinds}; 行 ${f.hitLines.join(', ')}${f.hits > f.hitLines.length ? ' 他' : ''}）`);
      }
      if (!withHits.length) console.log('  PII 混入なし');
      console.log('  ※ 値は出力しません。詳細確認は該当行を手動で参照のこと');
    }
  }
  const credHits = credentialHits(r);
  if (strict && credHits > 0) {
    console.error(`report-log-pii: ${credHits} 件の資格情報混入（jwt/bearer/apikey）を検出 — ログへの秘密値記録経路を遮断してください`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { report, scanFile, credentialHits };
