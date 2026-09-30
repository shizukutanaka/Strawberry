// KPIトレンド急増/急減アラート自動通知スクリプト
const fs = require('fs');
const path = require('path');
const { sendSlackMessage } = require('./slack-feedback-bot');
const { atomicWriteJSON } = require('../src/db/json/atomicWrite');

// 生成側（checklist-kpi-report.js）は同一ファイル `docs/checklist-kpi-report.md` を
// 上書きするため日付付き履歴は存在しない。前回値は本スクリプト自身が
// STATE_FILE（既定 data/kpi-trend-state.json）へ記録して比較する。
const REPORT_DIR = process.env.KPI_REPORT_DIR || path.join(__dirname, '../docs');
const REPORT_PREFIX = 'checklist-kpi-report';
const REPORT_SUFFIX = '.md';
const STATE_FILE = process.env.KPI_STATE_FILE
  || path.join(__dirname, '../data/kpi-trend-state.json');
const THRESHOLD = Number(process.env.KPI_ALERT_THRESHOLD) || 0.2; // 20%変動でアラート

// 最新の KPI レポート（日付付き履歴があれば名前順の最新、無ければ単一ファイル）を返す。
function getLatestReport() {
  if (!fs.existsSync(REPORT_DIR)) return null;
  const files = fs.readdirSync(REPORT_DIR)
    .filter(f => f.startsWith(REPORT_PREFIX) && f.endsWith(REPORT_SUFFIX))
    .sort();
  if (files.length === 0) return null;
  return path.join(REPORT_DIR, files[files.length - 1]);
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

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[alert-kpi-trend] 状態ファイルが破損しているため基準値を取り直します: ${e.message}`);
    }
    return {};
  }
}

function saveState(state) {
  atomicWriteJSON(STATE_FILE, state);
}

// 前回記録値との比較。同一レポートファイルの再実行では差分ゼロなので二重通知しない。
function alertKPITrend() {
  const report = getLatestReport();
  if (!report) {
    console.log('KPIレポートが見つかりません（先に npm run checklist-kpi-report を実行してください）');
    return { alerted: false, reason: 'no-report' };
  }
  const curr = parseKPI(report);
  if (curr.total === undefined) {
    console.warn(`[alert-kpi-trend] ${path.basename(report)} から KPI 値を解析できませんでした（形式変更の可能性）`);
    return { alerted: false, reason: 'unparseable' };
  }
  const prevState = loadState();
  const prev = prevState.stats;
  if (!prev || prev.total === undefined) {
    saveState({ stats: curr, file: path.basename(report), recordedAt: new Date().toISOString() });
    console.log('KPI 基準値を記録しました（初回実行のため比較なし）');
    return { alerted: false, reason: 'baseline' };
  }
  let msg = '';
  for (const key of ['todo', 'done', 'wip']) {
    if (prev[key] === undefined || curr[key] === undefined) continue;
    const diff = curr[key] - prev[key];
    const ratio = prev[key] === 0 ? 0 : diff / prev[key];
    if (Math.abs(ratio) >= THRESHOLD) {
      msg += `【KPIトレンドアラート】${key}が前回比${(ratio * 100).toFixed(1)}% (${prev[key]}→${curr[key]})\n`;
    }
  }
  saveState({ stats: curr, file: path.basename(report), recordedAt: new Date().toISOString() });
  if (msg) {
    sendSlackMessage(msg);
    console.log('KPIトレンドアラートをSlackに通知しました');
    return { alerted: true, message: msg };
  }
  console.log('KPI変動は閾値未満です');
  return { alerted: false, reason: 'below-threshold' };
}

if (require.main === module) {
  alertKPITrend();
}

module.exports = { alertKPITrend };
