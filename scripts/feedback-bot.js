// シンプルな現場フィードバック吸い上げBot（CLI/フォーム連携用サンプル）
const fs = require('fs');
const path = require('path');

const FEEDBACK_FILE = path.join(__dirname, '../docs/feedback-log.json');

const { sendSlackMessage } = require('./slack-feedback-bot');

function submitFeedback({ user, message, timestamp }) {
  let log = [];
  if (fs.existsSync(FEEDBACK_FILE)) {
    log = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
  }
  const entry = { user, message, timestamp: timestamp || new Date().toISOString() };
  log.push(entry);
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(log, null, 2));
  // Slack通知
  try {
    sendSlackMessage(`【新規フィードバック】${entry.user}: ${entry.message} (${entry.timestamp})`);
  } catch (e) {
    console.error('Slack通知失敗:', e);
  }
  console.log('フィードバックを記録しました。');
}

// 使い方例
// node scripts/feedback-bot.js "yourname" "改善案や現場の声をここに記入"
if (require.main === module) {
  const [,, user, ...msg] = process.argv;
  if (!user || msg.length === 0) {
    console.log('使い方: node scripts/feedback-bot.js <ユーザー名> <フィードバック内容>');
    process.exit(1);
  }
  submitFeedback({ user, message: msg.join(' ') });
}

module.exports = { submitFeedback };
