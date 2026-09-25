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
        },
        // notifier.js の AXIOS_SAFE_CONFIG と同規約: LINE API の応答停止で
        // サーバープロセス内の await が永久 pending になるのを防ぐ。
        timeout: 10_000,
      }
    );
  } catch (e) {
    // ログのみ
    console.warn('[LINE Notify] 通知失敗:', e);
  }
}

module.exports = { sendLineNotification };
