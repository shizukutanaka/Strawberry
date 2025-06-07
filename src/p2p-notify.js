// p2p-notify.js - 死活監視・異常自動通知の多チャネル＆多監視対象自動化
const { main: healthMain } = require('./p2p-health');
const { sendNotification, NotifyType } = require('./utils/notifier');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const HEALTH_FILE = path.join(__dirname, 'health.json');
const LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(__dirname, '../logs/audit.log');

// 通知先（環境変数で柔軟に切替）
const CHANNELS = [
  process.env.LINE_TOKEN ? { type: NotifyType.LINE, opts: { token: process.env.LINE_TOKEN } } : null,
  process.env.DISCORD_WEBHOOK ? { type: NotifyType.DISCORD, opts: { webhookUrl: process.env.DISCORD_WEBHOOK } } : null,
  process.env.SLACK_WEBHOOK ? { type: NotifyType.SLACK, opts: { webhookUrl: process.env.SLACK_WEBHOOK } } : null,
  process.env.GENERIC_WEBHOOK ? { type: NotifyType.WEBHOOK, opts: { webhookUrl: process.env.GENERIC_WEBHOOK } } : null,
  process.env.EMAIL_TO ? { type: NotifyType.EMAIL, opts: { to: process.env.EMAIL_TO, subject: '【Strawberry】死活監視アラート' } } : null
].filter(Boolean);

// 監視対象API/外部サービス
const MONITOR_TARGETS = (process.env.MONITOR_TARGETS || 'http://localhost:3000/api/system/info').split(',');

function logAudit(event) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ...event, time: new Date().toISOString() }) + '\n');
  } catch (e) {}
}

async function checkHealthFile() {
  if (!fs.existsSync(HEALTH_FILE)) return;
  const health = JSON.parse(fs.readFileSync(HEALTH_FILE));
  if (health.peerCount === 0) {
    const msg = `【P2Pノード障害検知】\nピア接続がありません（${health.peerId}）\n${new Date(health.timestamp).toLocaleString()}`;
    await notifyAll(msg, 'NODE_DOWN');
  }
}

async function checkExternalTargets() {
  for (const url of MONITOR_TARGETS) {
    try {
      const res = await axios.get(url, { timeout: 7000 });
      if (res.status !== 200) {
        await notifyAll(`【API死活監視】${url} が異常応答: ${res.status}`, 'API_DOWN');
      }
    } catch (e) {
      await notifyAll(`【API死活監視】${url} にアクセスできません: ${e.message}`, 'API_DOWN');
    }
  }
}

async function notifyAll(msg, type = 'ALERT') {
  for (const ch of CHANNELS) {
    try {
      await sendNotification(ch.type, msg, ch.opts);
    } catch (e) {
      // 通知失敗も監査ログ
      logAudit({ type: 'NOTIFY_FAIL', channel: ch.type, message: msg, error: e.message });
    }
  }
  logAudit({ type, message: msg });
}

function startNotifyLoop() {
  setInterval(() => { checkHealthFile(); checkExternalTargets(); }, 15000); // 15秒ごとに全監視
}

if (require.main === module) {
  healthMain();
  startNotifyLoop();
}

module.exports = {
  startNotifyLoop,
  checkHealthFile,
  checkExternalTargets,
  notifyAll,
};
