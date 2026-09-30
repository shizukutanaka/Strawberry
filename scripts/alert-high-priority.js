// 未対応・高優先度フィードバックをSlackにアラート通知するスクリプト
const { loadPriorityFeedback, sendAlert } = require('./lib/alert-common');

function alertHighPriority() {
  const feedbacks = loadPriorityFeedback();
  if (feedbacks.length === 0) {
    console.log('優先度付きフィードバックファイルがありません');
    return 0;
  }
  const alerts = feedbacks.filter(fb => fb.priority === '高' && (!fb.status || fb.status === '未対応'));
  if (alerts.length === 0) {
    console.log('未対応の高優先度フィードバックはありません');
    return 0;
  }
  sendAlert('【高優先度アラート】未対応の重要フィードバック', alerts);
  console.log('高優先度アラートをSlackに通知しました');
  return alerts.length;
}

if (require.main === module) {
  try {
    alertHighPriority();
  } catch (e) {
    console.error(`高優先度アラート通知に失敗: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { alertHighPriority };
