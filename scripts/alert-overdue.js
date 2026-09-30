// 期限切れタスクをSlackにアラート通知するスクリプト
const { loadPriorityFeedback, isOverdue, dueOf, sendAlert } = require('./lib/alert-common');

function alertOverdue() {
  const feedbacks = loadPriorityFeedback();
  if (feedbacks.length === 0) {
    console.log('優先度付きフィードバックファイルがありません');
    return 0;
  }
  const overdue = feedbacks.filter(fb => isOverdue(dueOf(fb)));
  if (overdue.length === 0) {
    console.log('期限切れタスクはありません');
    return 0;
  }
  sendAlert('【期限切れアラート】期限切れタスク', overdue);
  console.log('期限切れアラートをSlackに通知しました');
  return overdue.length;
}

if (require.main === module) {
  try {
    alertOverdue();
  } catch (e) {
    console.error(`期限切れアラート通知に失敗: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { alertOverdue };
