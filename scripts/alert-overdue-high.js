// 期限切れ＋高優先度タスクをSlackにアラート通知するスクリプト
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

function alertOverdueHigh() {
  if (!fs.existsSync(PRIORITY_FILE)) {
    console.log('優先度付きフィードバックファイルがありません');
    return;
  }
  const feedbacks = JSON.parse(fs.readFileSync(PRIORITY_FILE, 'utf8'));
  const overdueHigh = feedbacks.filter(fb => fb.priority === '高' && isOverdue(fb.due || fb.deadline || fb.期限 || fb.date));
  if (overdueHigh.length === 0) {
    console.log('期限切れかつ高優先度のタスクはありません');
    return;
  }
  const msg = `【期限切れ×高優先度アラート】期限切れかつ高優先度のタスクが${overdueHigh.length}件あります\n` +
    overdueHigh.map(fb => `- ${fb.due || fb.deadline || fb.期限 || fb.date || ''} ${fb.user || ''}: ${fb.message || ''}`).join('\n');
  sendSlackMessage(msg);
  console.log('期限切れ×高優先度アラートをSlackに通知しました');
}

if (require.main === module) {
  alertOverdueHigh();
}

module.exports = { alertOverdueHigh };
