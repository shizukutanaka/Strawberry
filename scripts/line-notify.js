// scripts/line-notify.js
// LINE通知モジュール（LINE_TOKENは環境変数LINE_TOKENで指定）
const axios = require('axios');

async function sendLineNotification(event, data) {
  if (!process.env.LINE_TOKEN) return;
  try {
    await axios.post('https://notify-api.line.me/api/notify',
      `message=[${event}] ${JSON.stringify(data)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${process.env.LINE_TOKEN}`
        }
      }
    );
  } catch (e) {
    // ログのみ
    console.warn('[LINE Notify] 通知失敗:', e);
  }
}

module.exports = { sendLineNotification };
