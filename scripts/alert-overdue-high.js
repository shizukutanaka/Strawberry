// 期限切れ＋高優先度タスクをSlackにアラート通知するスクリプト
const { loadPriorityFeedback, isOverdue, dueOf, sendAlert } = require('./lib/alert-common');

function alertOverdueHigh() {
  const feedbacks = loadPriorityFeedback();
  if (feedbacks.length === 0) {
    console.log('優先度付きフィードバックファイルがありません');
    return 0;
  }
  const overdueHigh = feedbacks.filter(fb => fb.priority === '高' && isOverdue(dueOf(fb)));
  if (overdueHigh.length === 0) {
    console.log('期限切れかつ高優先度のタスクはありません');
    return 0;
  }
  sendAlert('【期限切れ×高優先度アラート】期限切れかつ高優先度のタスク', overdueHigh);
  console.log('期限切れ×高優先度アラートをSlackに通知しました');
  return overdueHigh.length;
}

if (require.main === module) {
  try {
    alertOverdueHigh();
  } catch (e) {
    console.error(`期限切れ×高優先度アラート通知に失敗: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { alertOverdueHigh };
