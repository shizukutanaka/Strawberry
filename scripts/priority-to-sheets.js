// 優先度付きフィードバックをGoogle Sheets進捗ボードに転記（Google API認証情報が必要）
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authorize } = require('./google-sheets-auth');

const PRIORITY_FILE = path.join(__dirname, '../docs/feedback-priority.json');
const SPREADSHEET_ID = process.env.PROGRESS_SHEET_ID; // .envで指定
const SHEET_NAME = 'ProgressBoard';

async function appendBoard(auth) {
  if (!fs.existsSync(PRIORITY_FILE)) return;
  const feedbacks = JSON.parse(fs.readFileSync(PRIORITY_FILE, 'utf8'));
  const sheets = google.sheets({ version: 'v4', auth });
  // ステータスは初期値「未対応」
  const values = feedbacks.map(fb => [fb.timestamp, fb.user, fb.message, fb.priority, '未対応']);
  const resource = { values };
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:E${values.length+1}`,
    valueInputOption: 'RAW',
    resource
  });
  console.log('Google Sheets進捗ボードに転記しました。');
}

if (require.main === module) {
  if (!SPREADSHEET_ID) {
    console.error('PROGRESS_SHEET_IDが未設定です (.env でスプレッドシートIDを指定してください)');
    process.exit(1);
  }
  authorize()
    .then(auth => appendBoard(auth))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { appendBoard };
