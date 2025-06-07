// security-audit.js - 依存脆弱性自動監査・通知スクリプト
const { exec } = require('child_process');
const { sendNotification, NotifyType } = require('./utils/notifier');
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '../logs/security-audit.log');

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
}

function runNpmAudit() {
  exec('npm audit --json', { cwd: path.resolve(__dirname, '..') }, (err, stdout, stderr) => {
    let result = null;
    try {
      result = JSON.parse(stdout);
    } catch (e) {
      logAudit({ type: 'AUDIT_ERROR', message: 'npm audit出力パース失敗', error: e.message });
      return;
    }
    if (result && result.metadata && result.metadata.vulnerabilities && result.metadata.vulnerabilities.total > 0) {
      const msg = `依存脆弱性検知: ${result.metadata.vulnerabilities.total}件\n${JSON.stringify(result.metadata.vulnerabilities, null, 2)}`;
      logAudit({ type: 'VULN_FOUND', vulnerabilities: result.metadata.vulnerabilities });
      notifyAllChannels(msg);
    } else {
      logAudit({ type: 'NO_VULN', message: '脆弱性なし' });
    }
  });
}

if (require.main === module) {
  runNpmAudit();
}

module.exports = { runNpmAudit };
