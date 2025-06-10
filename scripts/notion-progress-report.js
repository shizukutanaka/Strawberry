// Notion進捗ボードからKPI自動集計・週次レポート生成（@notionhq/client利用）
const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const REPORT_FILE = path.join(__dirname, '../docs/notion-progress-report.md');

const notion = new Client({ auth: NOTION_TOKEN });

async function fetchAllPages() {
  let results = [];
  let cursor = undefined;
  while (true) {
    const res = await notion.databases.query({
      database_id: NOTION_DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    results = results.concat(res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return results;
}

function aggregateKPI(pages) {
  const kpi = { total: 0, done: 0, wip: 0, todo: 0, high: 0, mid: 0, low: 0 };
  for (const page of pages) {
    kpi.total++;
    const status = page.properties['ステータス']?.select?.name || '';
    if (status.includes('完了')) kpi.done++;
    else if (status.includes('対応中')) kpi.wip++;
    else kpi.todo++;
    const priority = page.properties['優先度']?.select?.name || '';
    if (priority.includes('高')) kpi.high++;
    else if (priority.includes('中')) kpi.mid++;
    else kpi.low++;
  }
  return kpi;
}

function renderReport(kpi, pages) {
  const now = new Date().toISOString().slice(0,10);
  let md = `# Notion進捗ボード週次KPIレポート (${now})\n\n`;
  md += `- 総フィードバック件数: ${kpi.total}\n- 完了: ${kpi.done}\n- 対応中: ${kpi.wip}\n- 未対応: ${kpi.todo}\n- 優先度(高): ${kpi.high}\n- 優先度(中): ${kpi.mid}\n- 優先度(低): ${kpi.low}\n\n`;
  md += `## 詳細一覧\n| 日時 | ユーザー | 内容 | 優先度 | ステータス |\n| ---- | ------- | ---- | ------ | ---------- |\n`;
  for (const page of pages) {
    const date = page.properties['日時']?.date?.start || '';
    const user = page.properties['ユーザー']?.title?.[0]?.plain_text || '';
    const message = page.properties['内容']?.rich_text?.[0]?.plain_text || '';
    const priority = page.properties['優先度']?.select?.name || '';
    const status = page.properties['ステータス']?.select?.name || '';
    md += `| ${date} | ${user} | ${message} | ${priority} | ${status} |\n`;
  }
  return md;
}

async function main() {
  const pages = await fetchAllPages();
  const kpi = aggregateKPI(pages);
  const report = renderReport(kpi, pages);
  fs.writeFileSync(REPORT_FILE, report);
  console.log('Notion進捗ボード週次KPIレポートを生成しました。');
}

if (require.main === module) {
  main();
}

module.exports = { main };
