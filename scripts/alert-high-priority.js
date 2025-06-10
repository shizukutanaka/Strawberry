// 未対応・高優先度フィードバックをSlackにアラート通知するスクリプト
const fs = require('fs');
const path = require('path');
const { sendSlackMessage } = require('./slack-feedback-bot');

const PRIORITY_FILE = path.join(__dirname, '../docs/feedback-priority.json');

function alertHighPriority() {
  if (!fs.existsSync(PRIORITY_FILE)) {
    console.log('優先度付きフィードバックファイルがありません');
    return;
  }
  const feedbacks = JSON.parse(fs.readFileSync(PRIORITY_FILE, 'utf8'));
  const alerts = feedbacks.filter(fb => fb.priority === '高' && (!fb.status || fb.status === '未対応'));
  if (alerts.length === 0) {
    console.log('未対応の高優先度フィードバックはありません');
    return;
  }
  const msg = `【高優先度アラート】未対応の重要フィードバックが${alerts.length}件あります\n` +
    alerts.map(fb => `- ${fb.timestamp || ''} ${fb.user || ''}: ${fb.message || ''}`).join('\n');
  sendSlackMessage(msg);
  console.log('高優先度アラートをSlackに通知しました');
}

if (require.main === module) {
  alertHighPriority();
}

module.exports = { alertHighPriority };
