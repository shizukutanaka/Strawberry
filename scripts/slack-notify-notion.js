// Notion週次KPIレポートをSlackに自動通知するスクリプト
const fs = require('fs');
const path = require('path');
const { sendSlackMessage } = require('./slack-feedback-bot');

const REPORT_FILE = path.join(__dirname, '../docs/notion-progress-report.md');

function notifyNotionReport() {
  if (!fs.existsSync(REPORT_FILE)) {
    console.log('Notion週次レポートがありません');
    return;
  }
  const report = fs.readFileSync(REPORT_FILE, 'utf8');
  // Slackは長文を分割送信
  const chunks = report.match(/([\s\S]{1,3000})/g) || [];
  chunks.forEach(chunk => sendSlackMessage(chunk));
  console.log('SlackにNotion週次KPIレポートを通知しました');
}

if (require.main === module) {
  notifyNotionReport();
}

module.exports = { notifyNotionReport };
