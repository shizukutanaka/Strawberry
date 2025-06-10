// KPI推移グラフ自動生成（chartjs-node-canvas使用）
const fs = require('fs');
const path = require('path');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const REPORT_DIR = path.join(__dirname, '../docs/');
const OUTPUT_FILE = path.join(REPORT_DIR, 'kpi-trend.png');
const WIDTH = 800;
const HEIGHT = 400;

// progress-report.mdの履歴からKPIを集計する（例: docs/progress-report_YYYY-MM-DD.md）
function loadKPIHistory() {
  const files = fs.readdirSync(REPORT_DIR)
    .filter(f => /^progress-report_\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
  const history = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(REPORT_DIR, file), 'utf8');
    const date = file.match(/(\d{4}-\d{2}-\d{2})/)[1];
    const kpi = {};
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('- 総フィードバック件数:')) kpi.total = parseInt(line.split(':')[1]);
      if (line.startsWith('- 完了:')) kpi.done = parseInt(line.split(':')[1]);
      if (line.startsWith('- 対応中:')) kpi.wip = parseInt(line.split(':')[1]);
      if (line.startsWith('- 未対応:')) kpi.todo = parseInt(line.split(':')[1]);
      if (line.startsWith('- 優先度(高):')) kpi.high = parseInt(line.split(':')[1]);
      if (line.startsWith('- 優先度(中):')) kpi.mid = parseInt(line.split(':')[1]);
      if (line.startsWith('- 優先度(低):')) kpi.low = parseInt(line.split(':')[1]);
    }
    if (Object.keys(kpi).length > 0) {
      history.push({ date, ...kpi });
    }
  }
  return history;
}

async function main() {
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
  main();
}

module.exports = { main };
