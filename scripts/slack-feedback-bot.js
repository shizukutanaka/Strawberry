// 新着フィードバックをSlackに即時通知するBot（feedback-bot.jsから利用可能）
const https = require('https');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL; // .envに設定

function sendSlackMessage(text) {
  if (!SLACK_WEBHOOK_URL) {
    console.error('SLACK_WEBHOOK_URLが未設定です');
    process.exit(1);
  }
  const data = JSON.stringify({ text });
  const url = new URL(SLACK_WEBHOOK_URL);
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  };
  const req = https.request(options, res => {
    if (res.statusCode !== 200) {
      console.error('Slack通知失敗:', res.statusCode);
    }
  });
  req.on('error', err => console.error('Slack通知エラー:', err));
  req.write(data);
  req.end();
}

module.exports = { sendSlackMessage };
