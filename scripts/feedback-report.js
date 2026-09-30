// フィードバック自動集計・週次KPIレポート生成スクリプト
const fs = require('fs');
const path = require('path');
const { loadFeedback } = require('./lib/feedback-store');

const REPORT_FILE = process.env.FEEDBACK_REPORT_PATH || path.join(__dirname, '../docs/feedback-report.md');

function aggregateFeedback() {
  const log = loadFeedback();
  // 直近7日分のみ抽出。timestamp がパース不能な行は除外（NaN 比較の暗黙除外を明示化）。
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return log.filter(fb => {
    const t = new Date(fb.timestamp);
    return !Number.isNaN(t.getTime()) && t >= since;
  });
}

function generateReport(feedbacks) {
  if (feedbacks.length === 0) {
    return '# フィードバック週次レポート\n\n今週の新規フィードバックはありません。\n';
  }
  let report = '# フィードバック週次レポート\n\n';
  report += `期間: ${String(feedbacks[0].timestamp).slice(0, 10)} 〜 ${String(feedbacks[feedbacks.length - 1].timestamp).slice(0, 10)}\n\n`;
  report += `総フィードバック件数: ${feedbacks.length}\n\n`;
  feedbacks.forEach((fb, i) => {
    report += `### ${i + 1}. ${fb.user}\n- 日時: ${fb.timestamp}\n- 内容: ${fb.message}\n\n`;
  });
  return report;
}

function run() {
  const feedbacks = aggregateFeedback();
  const report = generateReport(feedbacks);
  fs.writeFileSync(REPORT_FILE, report);
  console.log('週次フィードバックレポートを生成しました。');
  return report;
}

if (require.main === module) {
  try {
    run();
  } catch (e) {
    console.error(`レポート生成に失敗: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { aggregateFeedback, generateReport, run };
