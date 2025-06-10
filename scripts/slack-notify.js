// Slack通知テンプレート: フィードバックや週次レポートをSlackに自動通知
const fs = require('fs');
const path = require('path');
const https = require('https');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL; // .envに設定
const REPORT_FILE = path.join(__dirname, '../docs/feedback-report.md');

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

// 週次レポートをSlackに通知
function notifyReport() {
  if (!fs.existsSync(REPORT_FILE)) {
    console.log('週次レポートがありません');
    return;
  }
  const report = fs.readFileSync(REPORT_FILE, 'utf8');
  // Slackは長文を分割送信
  const chunks = report.match(/([\s\S]{1,3000})/g) || [];
  chunks.forEach(chunk => sendSlackMessage(chunk));
  console.log('Slackに週次レポートを通知しました');
}

if (require.main === module) {
  notifyReport();
}

module.exports = { notifyReport };
