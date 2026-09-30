// Google Sheetsへフィードバックを自動転記するサンプル（Google API認証情報が必要）
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { loadFeedback } = require('./lib/feedback-store');

const CREDENTIALS_PATH = path.join(__dirname, '../scripts/credentials.json');
const TOKEN_PATH = path.join(__dirname, '../scripts/token.json');
const SPREADSHEET_ID = process.env.FEEDBACK_SHEET_ID; // .envで指定
const SHEET_NAME = 'Feedback';

function readJsonOrThrow(filePath, hint) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${filePath} がありません。${hint}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`${filePath} の JSON が破損しています: ${e.message}`);
  }
}

async function authorize() {
  const credentials = readJsonOrThrow(
    CREDENTIALS_PATH,
    'Google Cloud Console から OAuth クライアント（installed app）の credentials.json を取得してください。'
  );
  const installed = credentials && credentials.installed;
  if (!installed || !installed.client_id || !installed.client_secret) {
    throw new Error('credentials.json に installed.client_id / client_secret がありません。');
  }
  const { client_secret, client_id, redirect_uris } = installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const token = readJsonOrThrow(TOKEN_PATH, 'OAuth フローを実行して token.json を生成してください。');
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

async function appendFeedback(auth) {
  if (!SPREADSHEET_ID) {
    throw new Error('FEEDBACK_SHEET_ID が未設定です（.env にスプレッドシート ID を指定してください）。');
  }
  const feedbacks = loadFeedback();
  if (feedbacks.length === 0) return;
  const sheets = google.sheets({ version: 'v4', auth });
  const values = feedbacks.map(fb => [fb.timestamp, fb.user, fb.message]);
  const resource = { values };
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:C${values.length + 1}`,
    valueInputOption: 'RAW',
    resource
  });
  console.log('Google Sheetsにフィードバックを転記しました。');
}

if (require.main === module) {
  (async () => {
    try {
      const auth = await authorize();
      await appendFeedback(auth);
    } catch (e) {
      console.error(`Sheets 転記に失敗: ${e.message}`);
      process.exit(1);
    }
  })();
}

module.exports = { appendFeedback, authorize };
