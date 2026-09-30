// Slack通知テンプレート: フィードバックや週次レポートをSlackに自動通知
const fs = require('fs');
const path = require('path');
// HTTP 送信は slack-feedback-bot の共有実装に集約（タイムアウト・URL検証・ソケット解放済み）。
const { sendSlackMessage } = require('./slack-feedback-bot');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL; // .envに設定
const REPORT_FILE = path.join(__dirname, '../docs/feedback-report.md');

// 週次レポートをSlackに通知
function notifyReport() {
  // CLI スクリプト契約: Webhook 未設定は即座に失敗終了させる（呼出側の沈黙成功を防ぐ）
  if (!SLACK_WEBHOOK_URL) {
    console.error('SLACK_WEBHOOK_URLが未設定です');
    process.exit(1);
  }
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
