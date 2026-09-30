// フィードバックに自動で優先度ラベルを付与するサンプル
const path = require('path');
const { atomicWriteJSON } = require('../src/db/json/atomicWrite');
const { loadFeedback } = require('./lib/feedback-store');

const PRIORITY_FILE = process.env.FEEDBACK_PRIORITY_PATH || path.join(__dirname, '../docs/feedback-priority.json');

// 簡易なキーワードベース優先度判定
function getPriority(message) {
  const high = ['障害', '停止', '重大', '遅延', 'セキュリティ', '漏洩', '致命', '不具合'];
  const mid = ['要望', '改善', '遅い', '不便', 'バグ', 'エラー'];
  if (high.some(k => message.includes(k))) return '高';
  if (mid.some(k => message.includes(k))) return '中';
  return '低';
}

function labelFeedback() {
  const log = loadFeedback();
  const labeled = log.map(fb => ({ ...fb, priority: getPriority(fb.message) }));
  atomicWriteJSON(PRIORITY_FILE, labeled);
  console.log('フィードバックに優先度ラベルを付与しました。');
  return labeled;
}

if (require.main === module) {
  try {
    labelFeedback();
  } catch (e) {
    console.error(`優先度ラベル付与に失敗: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { labelFeedback, getPriority };
