// フィードバック自動集計・週次KPIレポート生成スクリプト
const fs = require('fs');
const path = require('path');

const FEEDBACK_FILE = path.join(__dirname, '../docs/feedback-log.json');
const REPORT_FILE = path.join(__dirname, '../docs/feedback-report.md');

function aggregateFeedback() {
  if (!fs.existsSync(FEEDBACK_FILE)) {
    console.log('フィードバックログがありません。');
    return [];
  }
  const log = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
  // 直近7日分のみ抽出
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return log.filter(fb => new Date(fb.timestamp) >= since);
}

function generateReport(feedbacks) {
  if (feedbacks.length === 0) {
    return '# フィードバック週次レポート\n\n今週の新規フィードバックはありません。\n';
  }
  let report = '# フィードバック週次レポート\n\n';
  report += `期間: ${feedbacks[0].timestamp.slice(0,10)} 〜 ${feedbacks[feedbacks.length-1].timestamp.slice(0,10)}\n\n`;
  report += `総フィードバック件数: ${feedbacks.length}\n\n`;
  feedbacks.forEach((fb, i) => {
    report += `### ${i+1}. ${fb.user}\n- 日時: ${fb.timestamp}\n- 内容: ${fb.message}\n\n`;
  });
  return report;
}

const feedbacks = aggregateFeedback();
const report = generateReport(feedbacks);
fs.writeFileSync(REPORT_FILE, report);
console.log('週次フィードバックレポートを生成しました。');
