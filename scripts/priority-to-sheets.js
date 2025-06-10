// 優先度付きフィードバックをGoogle Sheets進捗ボードに転記（Google API認証情報が必要）
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const PRIORITY_FILE = path.join(__dirname, '../docs/feedback-priority.json');
const CREDENTIALS_PATH = path.join(__dirname, '../scripts/credentials.json');
const TOKEN_PATH = path.join(__dirname, '../scripts/token.json');
const SPREADSHEET_ID = process.env.PROGRESS_SHEET_ID; // .envで指定
const SHEET_NAME = 'ProgressBoard';

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

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
  authorize().then(auth => appendBoard(auth));
}

module.exports = { appendBoard };
