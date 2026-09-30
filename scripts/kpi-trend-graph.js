// KPI推移グラフ自動生成（chartjs-node-canvas使用）
const fs = require('fs');
const path = require('path');

const REPORT_DIR = process.env.KPI_REPORT_DIR || path.join(__dirname, '../docs/');
const OUTPUT_FILE = process.env.KPI_OUTPUT_PATH || path.join(REPORT_DIR, 'kpi-trend.png');
const WIDTH = 800;
const HEIGHT = 400;

// 行末の数値を安全に取り出す。パース不能（NaN）ならその系列は出力しない。
function kpiValue(line) {
  const v = parseInt(String(line).split(':')[1], 10);
  return Number.isFinite(v) ? v : undefined;
}

function parseKpiText(text) {
  const kpi = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('- 総フィードバック件数:')) kpi.total = kpiValue(line);
    if (line.startsWith('- 完了:')) kpi.done = kpiValue(line);
    if (line.startsWith('- 対応中:')) kpi.wip = kpiValue(line);
    if (line.startsWith('- 未対応:')) kpi.todo = kpiValue(line);
    if (line.startsWith('- 優先度(高):')) kpi.high = kpiValue(line);
    if (line.startsWith('- 優先度(中):')) kpi.mid = kpiValue(line);
    if (line.startsWith('- 優先度(低):')) kpi.low = kpiValue(line);
  }
  for (const k of Object.keys(kpi)) if (kpi[k] === undefined) delete kpi[k];
  return kpi;
}

// progress-report_YYYY-MM-DD.md の日付別履歴から KPI を集計する。
// 生成側（progress-report.js）は日付なし progress-report.md のみ出力するため、
// 日付付きが1件も無くても最新スナップショットを履歴の末尾として拾う
// （ファイルの mtime を日付として採用）。これにより日次アーカイブ運用前でも
// グラフが常に空になることがない。
function loadKPIHistory() {
  if (!fs.existsSync(REPORT_DIR)) return [];
  const files = fs.readdirSync(REPORT_DIR)
    .filter(f => /^progress-report_\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
  const history = [];
  for (const file of files) {
    const kpi = parseKpiText(fs.readFileSync(path.join(REPORT_DIR, file), 'utf8'));
    if (Object.keys(kpi).length > 0) {
      history.push({ date: file.match(/(\d{4}-\d{2}-\d{2})/)[1], ...kpi });
    }
  }
  const latestPath = path.join(REPORT_DIR, 'progress-report.md');
  if (fs.existsSync(latestPath)) {
    const kpi = parseKpiText(fs.readFileSync(latestPath, 'utf8'));
    if (Object.keys(kpi).length > 0) {
      const mtime = fs.statSync(latestPath).mtime.toISOString().slice(0, 10);
      // 同一日付の日付付き履歴があるならスナップショット側は新しい方を採用して置換
      const idx = history.findIndex(h => h.date === mtime);
      const entry = { date: mtime, ...kpi };
      if (idx >= 0) history[idx] = entry;
      else history.push(entry);
    }
  }
  return history.sort((a, b) => a.date.localeCompare(b.date));
}

async function main() {
  // optionalDependencies — 未導入環境ではグラフ描画のみスキップ可能にし、
  // require 時点での MODULE_NOT_FOUND クラッシュを避けるため遅延ロード。
  let ChartJSNodeCanvas;
  try {
    ({ ChartJSNodeCanvas } = require('chartjs-node-canvas'));
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') {
      console.error('chartjs-node-canvas がインストールされていません（npm install で optionalDependencies を導入してください）');
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  const history = loadKPIHistory();
  if (history.length === 0) {
    console.log('KPI履歴がありません');
    return;
  }
  const labels = history.map(h => h.date);
  const done = history.map(h => h.done);
  const wip = history.map(h => h.wip);
  const todo = history.map(h => h.todo);
  const high = history.map(h => h.high);
  const mid = history.map(h => h.mid);
  const low = history.map(h => h.low);

  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width: WIDTH, height: HEIGHT });
  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '完了', data: done, borderColor: 'green', fill: false },
        { label: '対応中', data: wip, borderColor: 'orange', fill: false },
        { label: '未対応', data: todo, borderColor: 'red', fill: false },
        { label: '高', data: high, borderColor: 'purple', borderDash: [5,5], fill: false },
        { label: '中', data: mid, borderColor: 'blue', borderDash: [5,5], fill: false },
        { label: '低', data: low, borderColor: 'gray', borderDash: [5,5], fill: false },
      ]
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: 'KPI週次推移グラフ'
        }
      }
    }
  };
  const buffer = await chartJSNodeCanvas.renderToBuffer(config);
  fs.writeFileSync(OUTPUT_FILE, buffer);
  console.log('KPI推移グラフを生成しました:', OUTPUT_FILE);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`KPI推移グラフ生成に失敗: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { main, loadKPIHistory, parseKpiText };
