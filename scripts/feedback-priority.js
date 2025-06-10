// フィードバックに自動で優先度ラベルを付与するサンプル
const fs = require('fs');
const path = require('path');

const FEEDBACK_FILE = path.join(__dirname, '../docs/feedback-log.json');
const PRIORITY_FILE = path.join(__dirname, '../docs/feedback-priority.json');

// 簡易なキーワードベース優先度判定
function getPriority(message) {
  const high = ['障害', '停止', '重大', '遅延', 'セキュリティ', '漏洩', '致命', '不具合'];
  const mid = ['要望', '改善', '遅い', '不便', 'バグ', 'エラー'];
  if (high.some(k => message.includes(k))) return '高';
  if (mid.some(k => message.includes(k))) return '中';
  return '低';
}

function labelFeedback() {
  if (!fs.existsSync(FEEDBACK_FILE)) return;
  const log = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
  const labeled = log.map(fb => ({ ...fb, priority: getPriority(fb.message) }));
  fs.writeFileSync(PRIORITY_FILE, JSON.stringify(labeled, null, 2));
  console.log('フィードバックに優先度ラベルを付与しました。');
}

if (require.main === module) {
  labelFeedback();
}

module.exports = { labelFeedback };
