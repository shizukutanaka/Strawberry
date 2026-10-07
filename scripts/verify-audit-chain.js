#!/usr/bin/env node
// scripts/verify-audit-chain.js — 監査ログのハッシュ連鎖を検証する運用ツール
//
// src/utils/audit-log.js が各エントリを sha256(prevHash + line) で連鎖させ、
// 末尾ハッシュを .hash ファイルへ保存する。verifyAuditLogIntegrity() は内部関数で
// 運用者が直接実行する導線が無かったため、ここで公開する。
// 改竄・クラッシュ断片・行単位の破損を exit code で報告する。
//
// 使い方:
//   node scripts/verify-audit-chain.js [audit.logのパス] [--json]
//   既定: $AUDIT_LOG_PATH または logs/audit.log、ハッシュは .log→.hash 規約
//
// 終了コード: 0=連鎖一致 / 1=不一致・ファイル欠落・異常

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function defaultLogPath() {
  return process.env.AUDIT_LOG_PATH || path.join(__dirname, '../logs/audit.log');
}
function hashPathFor(logPath) {
  if (process.env.AUDIT_HASH_PATH) return process.env.AUDIT_HASH_PATH;
  return logPath.endsWith('.log') ? `${logPath.slice(0, -4)}.hash` : `${logPath}.hash`;
}

function verify(logPath = defaultLogPath()) {
  const hashPath = hashPathFor(logPath);
  const result = {
    logPath,
    hashPath,
    lines: 0,
    malformedLines: [],
    storedHash: null,
    recomputedHash: null,
    match: false,
    error: null,
  };
  if (!fs.existsSync(logPath)) {
    result.error = 'log file not found';
    return result;
  }
  if (!fs.existsSync(hashPath)) {
    result.error = 'hash file not found';
    return result;
  }
  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  result.lines = lines.length;
  let prevHash = '';
  lines.forEach((line, i) => {
    try {
      const entry = JSON.parse(line);
      // appendAuditLog が書く最小形 — 形式外の行は手動挿入の兆候
      if (typeof entry !== 'object' || entry === null
          || typeof entry.timestamp !== 'string' || typeof entry.action !== 'string') {
        result.malformedLines.push(i + 1);
      }
    } catch (_) {
      result.malformedLines.push(i + 1);
    }
    prevHash = crypto.createHash('sha256').update(prevHash + line).digest('hex');
  });
  result.storedHash = fs.readFileSync(hashPath, 'utf-8').trim();
  result.recomputedHash = prevHash;
  result.match = result.storedHash === result.recomputedHash;
  return result;
}

function main() {
  const jsonMode = process.argv.includes('--json');
  const logPath = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const r = verify(logPath);
  if (jsonMode) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('[verify-audit-chain]');
    console.log(`  log: ${r.logPath}`);
    console.log(`  entries: ${r.lines}`);
    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
    } else {
      console.log(`  stored:     ${(r.storedHash || '').slice(0, 24)}...`);
      console.log(`  recomputed: ${(r.recomputedHash || '').slice(0, 24)}...`);
      console.log(r.match
        ? '  OK — ハッシュ連鎖一致'
        : '  MISMATCH — 改竄・クラッシュ断片・ハッシュファイルのずれの可能性');
      if (r.malformedLines.length) {
        console.log(`  warning: 形式外の行 ${r.malformedLines.length}件 (lines: ${r.malformedLines.slice(0, 10).join(', ')}${r.malformedLines.length > 10 ? ', ...' : ''})`);
      }
    }
  }
  process.exit(r.error || !r.match ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { verify, hashPathFor };
