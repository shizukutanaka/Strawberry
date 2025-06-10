// チェックリスト進捗KPI自動集計・レポート生成スクリプト
const fs = require('fs');
const path = require('path');

const CHECKLIST_FILE = path.join(__dirname, '../improvement_checklist2.md');
const REPORT_FILE = path.join(__dirname, '../docs/checklist-kpi-report.md');

function parseChecklist() {
  const text = fs.readFileSync(CHECKLIST_FILE, 'utf8');
  const lines = text.split('\n');
  let total = 0, done = 0, wip = 0, todo = 0;
  let improvements = 0;
  const categories = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^- \[x\]/.test(line)) { done++; total++; }
    else if (/^- \[-\]/.test(line)) { wip++; total++; }
    else if (/^- \[ \]/.test(line)) { todo++; total++; }
    // 改善案カテゴリ別カウント
    if (line.includes('【改善案】')) {
      improvements++;
      const match = line.match(/【改善案】(.+)/);
      if (match) {
        const cat = match[1].split(/[。\n]/)[0].trim();
        categories[cat] = (categories[cat] || 0) + 1;
      }
    }
  }
  return { total, done, wip, todo, improvements, categories };
}

function renderReport(stat) {
  const now = new Date().toISOString().slice(0,10);
  let md = `# チェックリスト進捗KPIレポート (${now})\n\n`;
  md += `- 総タスク数: ${stat.total}\n- 完了: ${stat.done}\n- 対応中: ${stat.wip}\n- 未対応: ${stat.todo}\n- 改善案数: ${stat.improvements}\n\n`;
  if (Object.keys(stat.categories).length > 0) {
    md += '## 改善案カテゴリ別件数\n';
    for (const [cat, count] of Object.entries(stat.categories)) {
      md += `- ${cat}: ${count}\n`;
    }
    md += '\n';
  }
  return md;
}

function main() {
  const stat = parseChecklist();
  const report = renderReport(stat);
  fs.writeFileSync(REPORT_FILE, report);
  console.log('チェックリスト進捗KPIレポートを生成しました。');
}

if (require.main === module) {
  main();
}

module.exports = { main };
