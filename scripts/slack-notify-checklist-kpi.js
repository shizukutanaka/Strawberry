// チェックリストKPIレポートをSlackに自動通知するスクリプト
const fs = require('fs');
const path = require('path');
const { sendSlackMessage } = require('./slack-feedback-bot');

const REPORT_FILE = path.join(__dirname, '../docs/checklist-kpi-report.md');

function notifyChecklistKPI() {
  if (!fs.existsSync(REPORT_FILE)) {
    console.log('チェックリストKPIレポートがありません');
    return;
  }
  const report = fs.readFileSync(REPORT_FILE, 'utf8');
  // Slackは長文を分割送信
  const chunks = report.match(/([\s\S]{1,3000})/g) || [];
  chunks.forEach(chunk => sendSlackMessage(chunk));
  console.log('SlackにチェックリストKPIレポートを通知しました');
}

if (require.main === module) {
  notifyChecklistKPI();
}

module.exports = { notifyChecklistKPI };
