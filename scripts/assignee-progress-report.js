// 担当者別進捗リスト自動生成＆Slack通知スクリプト
const fs = require('fs');
const path = require('path');
const { sendSlackMessage } = require('./slack-feedback-bot');

const PRIORITY_FILE = process.env.FEEDBACK_PRIORITY_PATH || path.join(__dirname, '../docs/feedback-priority.json');
const REPORT_FILE = process.env.ASSIGNEE_REPORT_PATH || path.join(__dirname, '../docs/assignee-progress-report.md');

function loadPriorityFile() {
  if (!fs.existsSync(PRIORITY_FILE)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(PRIORITY_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`${PRIORITY_FILE} が破損しています: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${PRIORITY_FILE} は配列ではありません（期待しない構造のため処理を中止）`);
  }
  return parsed;
}

function parseAssigneeProgress() {
  const feedbacks = loadPriorityFile();
  const users = {};
  for (const fb of feedbacks) {
    if (fb === null || typeof fb !== 'object') continue;
    const user = (typeof fb.assignee === 'string' && fb.assignee)
      || (typeof fb.user === 'string' && fb.user) || '未割当';
    if (!users[user]) users[user] = { 未対応: 0, 対応中: 0, 完了: 0, tasks: [] };
    // 旧版/手編集で非文字列の status が混入しても includes で落ちないよう文字列化
    const status = typeof fb.status === 'string' && fb.status ? fb.status : '未対応';
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
  // レポートファイルの生成は通知の成否と独立 — Slack 障害でレポート自体を
  // 失敗扱いしないよう通知エラーは警告に留める。
  try {
    notifySlack(md);
  } catch (e) {
    console.error(`Slack通知に失敗（レポートは生成済み）: ${e.message}`);
  }
  console.log('担当者別進捗レポートを生成しSlackに通知しました。');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`担当者別進捗レポート生成に失敗: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { main, parseAssigneeProgress, renderReport };
