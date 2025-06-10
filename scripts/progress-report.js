// Google Sheets進捗ボードからKPI集計・週次レポート自動生成
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, '../scripts/credentials.json');
const TOKEN_PATH = path.join(__dirname, '../scripts/token.json');
const SPREADSHEET_ID = process.env.PROGRESS_SHEET_ID;
const SHEET_NAME = 'ProgressBoard';
const REPORT_FILE = path.join(__dirname, '../docs/progress-report.md');

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

async function fetchBoard(auth) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:E1000`,
  });
  return res.data.values || [];
}

function aggregateKPI(rows) {
  const kpi = {
    total: rows.length,
    done: 0,
    wip: 0,
    todo: 0,
    high: 0,
    mid: 0,
    low: 0
  };
  rows.forEach(row => {
    const status = row[4] || '';
    if (status.includes('完了')) kpi.done++;
    else if (status.includes('対応中')) kpi.wip++;
    else kpi.todo++;
    const priority = row[3] || '';
    if (priority.includes('高')) kpi.high++;
    else if (priority.includes('中')) kpi.mid++;
    else kpi.low++;
  });
  return kpi;
}

function renderReport(kpi, rows) {
  const now = new Date().toISOString().slice(0,10);
  return `# 進捗ボード週次KPIレポート (${now})\n\n- 総フィードバック件数: ${kpi.total}\n- 完了: ${kpi.done}\n- 対応中: ${kpi.wip}\n- 未対応: ${kpi.todo}\n- 優先度(高): ${kpi.high}\n- 優先度(中): ${kpi.mid}\n- 優先度(低): ${kpi.low}\n\n## 詳細一覧\n| 日時 | ユーザー | 内容 | 優先度 | ステータス |\n| ---- | ------- | ---- | ------ | ---------- |\n${rows.map(r => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`).join('\n')}\n`;
}

async function main() {
  const auth = await authorize();
  const rows = await fetchBoard(auth);
  const kpi = aggregateKPI(rows);
  const report = renderReport(kpi, rows);
  fs.writeFileSync(REPORT_FILE, report);
  console.log('進捗ボード週次KPIレポートを生成しました。');
}

if (require.main === module) {
  main();
}

module.exports = { main };
