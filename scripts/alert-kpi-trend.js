// KPIトレンド急増/急減アラート自動通知スクリプト
const fs = require('fs');
const path = require('path');
const { sendSlackMessage } = require('./slack-feedback-bot');

// 直近2回分のKPIレポートファイル（例: docs/checklist-kpi-report-YYYY-MM-DD.md）
const REPORT_DIR = path.join(__dirname, '../docs');
const REPORT_PREFIX = 'checklist-kpi-report';
const REPORT_SUFFIX = '.md';
const THRESHOLD = 0.2; // 20%変動でアラート

function getLatestReports() {
  const files = fs.readdirSync(REPORT_DIR)
    .filter(f => f.startsWith(REPORT_PREFIX) && f.endsWith(REPORT_SUFFIX))
    .sort()
    .slice(-2);
  if (files.length < 2) return [];
  return files.map(f => path.join(REPORT_DIR, f));
}

function parseKPI(file) {
  const text = fs.readFileSync(file, 'utf8');
  const stat = {};
  const match = text.match(/総タスク数: (\d+)[\s\S]*?完了: (\d+)[\s\S]*?対応中: (\d+)[\s\S]*?未対応: (\d+)/);
  if (match) {
    stat.total = parseInt(match[1]);
    stat.done = parseInt(match[2]);
    stat.wip = parseInt(match[3]);
    stat.todo = parseInt(match[4]);
  }
  return stat;
}

function alertKPITrend() {
  const reports = getLatestReports();
  if (reports.length < 2) {
    console.log('KPIレポートが2つ以上必要です');
    return;
  }
  const prev = parseKPI(reports[0]);
  const curr = parseKPI(reports[1]);
  let msg = '';
  for (const key of ['todo', 'done', 'wip']) {
    if (prev[key] === undefined || curr[key] === undefined) continue;
    const diff = curr[key] - prev[key];
    const ratio = prev[key] === 0 ? 0 : diff / prev[key];
    if (Math.abs(ratio) >= THRESHOLD) {
      msg += `【KPIトレンドアラート】${key}が前回比${(ratio*100).toFixed(1)}% (${prev[key]}→${curr[key]})\n`;
    }
  }
  if (msg) {
    sendSlackMessage(msg);
    console.log('KPIトレンドアラートをSlackに通知しました');
  } else {
    console.log('KPI変動は閾値未満です');
  }
}

if (require.main === module) {
  alertKPITrend();
}

module.exports = { alertKPITrend };
