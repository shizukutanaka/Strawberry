// security-audit.js - 依存脆弱性自動監査・通知スクリプト
const { exec } = require('child_process');
const { sendNotification, NotifyType } = require('./utils/notifier');
const fs = require('fs');
const path = require('path');
const { appendRotated } = require('./utils/log-rotate');

const LOG_PATH = path.join(__dirname, '../logs/security-audit.log');

function logAudit(event) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    appendRotated(LOG_PATH, JSON.stringify({ ...event, time: new Date().toISOString() }) + '\n');
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

// npm audit は脆弱性があると終了コード 1 を返すが stdout の JSON は有効 — err != null
// でも parse は継続する。一方で timeout による kill や maxBuffer 超過（切断された JSON）
// の場合は err の内容をログに残す（診断不能な「パース失敗」のみだと原因追跡できない）。
const AUDIT_EXEC_OPTIONS = {
  cwd: path.resolve(__dirname, '..'),
  // 脆弱性が多いと `via` ツリー込みの出力は容易に数 MB を超える。既定の 1MB で
  // 切断されると恒久的に「パース失敗」だけが記録され脆弱性が一切通知されない。
  maxBuffer: 32 * 1024 * 1024,
  // レジストリ障害・ネットワーク停止で npm がハングすると、タイムアウト無しでは
  // 監視プロセス自体が永久滞留して以降の監査が一切走らない。
  timeout: 120 * 1000,
};

function runNpmAudit() {
  exec('npm audit --json', AUDIT_EXEC_OPTIONS, (err, stdout, stderr) => {
    let result = null;
    try {
      result = JSON.parse(stdout);
    } catch (e) {
      logAudit({
        type: 'AUDIT_ERROR',
        message: 'npm audit出力パース失敗',
        error: e.message,
        execError: err ? String(err.message || err) : null,
        stderr: stderr ? String(stderr).slice(0, 500) : null,
      });
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
