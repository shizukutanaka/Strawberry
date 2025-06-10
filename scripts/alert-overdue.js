// 期限切れタスクをSlackにアラート通知するスクリプト
const fs = require('fs');
const path = require('path');
const { sendSlackMessage } = require('./slack-feedback-bot');

const PRIORITY_FILE = path.join(__dirname, '../docs/feedback-priority.json');

function isOverdue(due) {
  if (!due) return false;
  const today = new Date();
  const dueDate = new Date(due);
  return !isNaN(dueDate) && dueDate < today;
}

function alertOverdue() {
  if (!fs.existsSync(PRIORITY_FILE)) {
    console.log('優先度付きフィードバックファイルがありません');
    return;
  }
  const feedbacks = JSON.parse(fs.readFileSync(PRIORITY_FILE, 'utf8'));
  const overdue = feedbacks.filter(fb => isOverdue(fb.due || fb.deadline || fb.期限 || fb.date));
  if (overdue.length === 0) {
    console.log('期限切れタスクはありません');
    return;
  }
  const msg = `【期限切れアラート】期限切れタスクが${overdue.length}件あります\n` +
    overdue.map(fb => `- ${fb.due || fb.deadline || fb.期限 || fb.date || ''} ${fb.user || ''}: ${fb.message || ''}`).join('\n');
  sendSlackMessage(msg);
  console.log('期限切れアラートをSlackに通知しました');
}

if (require.main === module) {
  alertOverdue();
}

module.exports = { alertOverdue };
