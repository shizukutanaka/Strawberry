// security-audit.js - 依存脆弱性自動監査・通知スクリプト
const { exec } = require('child_process');
const { sendNotification, NotifyType } = require('./utils/notifier');
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '../logs/security-audit.log');
// 最後に通知した脆弱性セットのフィンガープリント（同一内容での再通知を防ぐ）
const STATE_PATH = path.join(__dirname, '../logs/security-audit-state.json');

function logAudit(event) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ...event, time: new Date().toISOString() }) + '\n');
  } catch (e) {}
}

function notifyAllChannels(msg) {
  const channels = [
    process.env.LINE_TOKEN ? { type: NotifyType.LINE, opts: { token: process.env.LINE_TOKEN } } : null,
    process.env.DISCORD_WEBHOOK ? { type: NotifyType.DISCORD, opts: { webhookUrl: process.env.DISCORD_WEBHOOK } } : null,
    process.env.EMAIL_TO ? { type: NotifyType.EMAIL, opts: { to: process.env.EMAIL_TO, subject: '【Strawberry】依存脆弱性検知' } } : null
  ].filter(Boolean);
  channels.forEach(ch => {
    sendNotification(ch.type, msg, ch.opts).catch(()=>{});
  });
  return channels.length;
}

// npm audit --json（npm v7+ 形式）から脆弱性セットのフィンガープリントを抽出。
// パッケージ名:深刻度 のソート済み一覧 — 内容が同じなら再通知しない。
function computeFingerprint(result) {
  const vulns = (result && result.vulnerabilities) || {};
  const ids = Object.entries(vulns).map(([name, v]) => `${name}:${v && v.severity || 'unknown'}`).sort();
  const total = (result && result.metadata && result.metadata.vulnerabilities && result.metadata.vulnerabilities.total) || 0;
  return { total, ids };
}

function readLastFingerprint(stateFile = STATE_PATH) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf-8')).ids || null; } catch (_) { return null; }
}

function writeFingerprint(ids, stateFile = STATE_PATH) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ids, notifiedAt: new Date().toISOString() }));
  } catch (e) {}
}

/**
 * パース済み npm audit 結果を評価し、脆弱性セットが前回通知から変化した場合のみ通知する。
 * exec/ネットワークを含まない純粋判定部分（テスト容易化のため分離）。
 * @returns {{vulnCount:number, changed:boolean, notifiedChannels:number}}
 */
function auditDependencies(result, { stateFile = STATE_PATH, notify = notifyAllChannels } = {}) {
  const { total, ids } = computeFingerprint(result);
  if (total === 0 || ids.length === 0) {
    logAudit({ type: 'NO_VULN', message: '脆弱性なし' });
    writeFingerprint(ids, stateFile);
    return { vulnCount: 0, changed: false, notifiedChannels: 0 };
  }
  const last = readLastFingerprint(stateFile);
  const changed = !last || last.join('') !== ids.join('');
  if (!changed) {
    // 同一セット — 日次実行でも繰り返し通知しない
    logAudit({ type: 'VULN_UNCHANGED', vulnerabilities: total });
    return { vulnCount: total, changed: false, notifiedChannels: 0 };
  }
  const msg = `依存脆弱性検知: ${total}件\n${JSON.stringify((result.metadata && result.metadata.vulnerabilities) || {}, null, 2)}\n${ids.join('\n')}`;
  logAudit({ type: 'VULN_FOUND', vulnerabilities: total, ids });
  const notifiedChannels = notify(msg);
  writeFingerprint(ids, stateFile);
  return { vulnCount: total, changed: true, notifiedChannels };
}

function runNpmAudit() {
  return new Promise((resolve) => {
    exec('npm audit --json', { cwd: path.resolve(__dirname, '..'), maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      let result = null;
      try {
        result = JSON.parse(stdout);
      } catch (e) {
        logAudit({ type: 'AUDIT_ERROR', message: 'npm audit出力パース失敗', error: e.message });
        return resolve({ error: 'parse_failed' });
      }
      resolve(auditDependencies(result));
    });
  });
}

if (require.main === module) {
  runNpmAudit().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { runNpmAudit, auditDependencies, computeFingerprint };
