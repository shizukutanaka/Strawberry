// scripts/line-notify.js
// LINE通知モジュール（LINE_TOKENは環境変数LINE_TOKENで指定）
const axios = require('axios');

// 応答しない notify-api.line.me で監視プロセスが滞留しないようタイムアウトを付与。
const LINE_TIMEOUT_MS = parseInt(process.env.LINE_NOTIFY_TIMEOUT_MS || '', 10);
const NOTIFY_TIMEOUT_MS = Number.isFinite(LINE_TIMEOUT_MS) && LINE_TIMEOUT_MS > 0
  ? LINE_TIMEOUT_MS : 10000;

async function sendLineNotification(event, data) {
  if (!process.env.LINE_TOKEN) return;
  try {
    await axios.post('https://notify-api.line.me/api/notify',
      `message=[${event}] ${JSON.stringify(data)}`,
      {
        timeout: NOTIFY_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${process.env.LINE_TOKEN}`
        }
      }
    );
  } catch (e) {
    // axios のエラーオブジェクトは config.headers.Authorization（= LINE_TOKEN）を内包するため
    // 丸ごとログ出力しない。メッセージと HTTP ステータスのみ記録する。
    const status = e?.response?.status;
    console.warn('[LINE Notify] 通知失敗:', status ? `HTTP ${status}` : e?.message || 'unknown error');
  }
}

module.exports = { sendLineNotification };
