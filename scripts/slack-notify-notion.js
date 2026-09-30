// Notion週次KPIレポートをSlackに自動通知するスクリプト
// dotenv は slack-feedback-bot を require する「前」に読み込むこと。
// slack-feedback-bot はモジュール評価時に process.env.SLACK_WEBHOOK_URL を
// 定数へ捕捉するため、後読み込みでは .env の値が反映されない（通知が常にスキップされる）。
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sendSlackMessage } = require('./slack-feedback-bot');

const REPORT_FILE = path.join(__dirname, '../docs/notion-progress-report.md');

function notifyNotionReport() {
  if (!fs.existsSync(REPORT_FILE)) {
    console.log('Notion週次レポートがありません');
    return;
  }
  let report;
  try {
    report = fs.readFileSync(REPORT_FILE, 'utf8');
  } catch (e) {
    console.error(`レポートの読み込みに失敗しました: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  // Slackは長文を分割送信
  const chunks = report.match(/([\s\S]{1,3000})/g) || [];
  chunks.forEach(chunk => sendSlackMessage(chunk));
  console.log('SlackにNotion週次KPIレポートを通知しました');
}

if (require.main === module) {
  notifyNotionReport();
}

module.exports = { notifyNotionReport };
