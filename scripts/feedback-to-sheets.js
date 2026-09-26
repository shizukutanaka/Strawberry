// Google Sheetsへフィードバックを自動転記するサンプル（Google API認証情報が必要）
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authorize } = require('./google-sheets-auth');

const FEEDBACK_FILE = path.join(__dirname, '../docs/feedback-log.json');
const SPREADSHEET_ID = process.env.FEEDBACK_SHEET_ID; // .envで指定
const SHEET_NAME = 'Feedback';

async function appendFeedback(auth) {
  if (!fs.existsSync(FEEDBACK_FILE)) return;
  const feedbacks = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
  const sheets = google.sheets({ version: 'v4', auth });
  const values = feedbacks.map(fb => [fb.timestamp, fb.user, fb.message]);
  const resource = { values };
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:C${values.length+1}`,
    valueInputOption: 'RAW',
    resource
  });
  console.log('Google Sheetsにフィードバックを転記しました。');
}

if (require.main === module) {
  if (!SPREADSHEET_ID) {
    console.error('FEEDBACK_SHEET_IDが未設定です (.env でスプレッドシートIDを指定してください)');
    process.exit(1);
  }
  authorize()
    .then(auth => appendFeedback(auth))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { appendFeedback };
