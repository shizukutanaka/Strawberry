// p2p-notify.js - MVP用 異常時のLINE通知自動化（死活監視・障害アラート）
const { main: healthMain } = require('./p2p-health');
const { sendNotification, NotifyType } = require('./utils/notifier');
const fs = require('fs');
const path = require('path');

const HEALTH_FILE = path.join(__dirname, 'health.json');
const LINE_TOKEN = process.env.LINE_TOKEN;

function checkAndNotify() {
  if (!fs.existsSync(HEALTH_FILE)) return;
  const health = JSON.parse(fs.readFileSync(HEALTH_FILE));
  if (health.peerCount === 0) {
    const msg = `【P2Pノード障害検知】\nピア接続がありません（${health.peerId}）\n${new Date(health.timestamp).toLocaleString()}`;
    if (LINE_TOKEN) {
      sendNotification(NotifyType.LINE, msg, { token: LINE_TOKEN })
        .then(() => console.log('LINE通知送信:', msg))
        .catch(err => console.error('LINE通知失敗:', err.message));
    } else {
      console.warn('LINE_TOKEN未設定のため通知できません:', msg);
    }
  }
}

function startNotifyLoop() {
  setInterval(checkAndNotify, 15000); // 15秒ごとに監視
}

if (require.main === module) {
  healthMain(); // 死活監視も同時起動
  startNotifyLoop();
}

module.exports = {
  startNotifyLoop,
  checkAndNotify,
};
