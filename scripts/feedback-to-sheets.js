// Google Sheetsへフィードバックを自動転記するサンプル（Google API認証情報が必要）
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const FEEDBACK_FILE = path.join(__dirname, '../docs/feedback-log.json');
const CREDENTIALS_PATH = path.join(__dirname, '../scripts/credentials.json');
const TOKEN_PATH = path.join(__dirname, '../scripts/token.json');
const SPREADSHEET_ID = process.env.FEEDBACK_SHEET_ID; // .envで指定
const SHEET_NAME = 'Feedback';

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

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
  authorize().then(auth => appendFeedback(auth));
}

module.exports = { appendFeedback };
