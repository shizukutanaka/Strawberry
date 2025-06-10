// 担当者別進捗リスト自動生成＆Slack通知スクリプト
const fs = require('fs');
const path = require('path');
const { sendSlackMessage } = require('./slack-feedback-bot');

const PRIORITY_FILE = path.join(__dirname, '../docs/feedback-priority.json');
const REPORT_FILE = path.join(__dirname, '../docs/assignee-progress-report.md');

function parseAssigneeProgress() {
  if (!fs.existsSync(PRIORITY_FILE)) return {};
  const feedbacks = JSON.parse(fs.readFileSync(PRIORITY_FILE, 'utf8'));
  const users = {};
  for (const fb of feedbacks) {
    const user = fb.assignee || fb.user || '未割当';
    if (!users[user]) users[user] = { 未対応: 0, 対応中: 0, 完了: 0, tasks: [] };
    const status = fb.status || '未対応';
    if (status.includes('完了')) users[user]['完了']++;
    else if (status.includes('対応中')) users[user]['対応中']++;
    else users[user]['未対応']++;
    users[user].tasks.push({ message: fb.message, status, priority: fb.priority });
  }
  return users;
}

function renderReport(users) {
  const now = new Date().toISOString().slice(0,10);
  let md = `# 担当者別進捗レポート (${now})\n\n`;
  for (const [user, stat] of Object.entries(users)) {
    md += `## ${user}\n- 未対応: ${stat['未対応']}\n- 対応中: ${stat['対応中']}\n- 完了: ${stat['完了']}\n`;
    stat.tasks.forEach(t => {
      md += `  - [${t.status}] (${t.priority || ''}) ${t.message}\n`;
    });
    md += '\n';
  }
  return md;
}

function notifySlack(md) {
  // Slackは長文を分割送信
  const chunks = md.match(/([\s\S]{1,3000})/g) || [];
  chunks.forEach(chunk => sendSlackMessage(chunk));
}

function main() {
  const users = parseAssigneeProgress();
  const md = renderReport(users);
  fs.writeFileSync(REPORT_FILE, md);
  notifySlack(md);
  console.log('担当者別進捗レポートを生成しSlackに通知しました。');
}

if (require.main === module) {
  main();
}

module.exports = { main };
