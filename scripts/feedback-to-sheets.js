// Google Sheetsへフィードバックを自動転記するサンプル（Google API認証情報が必要）
const fs = require('fs');
const path = require('path');
const { authorize } = require('./google-sheets-auth');
const { loadFeedback } = require('./lib/feedback-store');

const SPREADSHEET_ID = process.env.FEEDBACK_SHEET_ID; // .envで指定
const SHEET_NAME = 'Feedback';

async function appendFeedback(auth) {
  if (!SPREADSHEET_ID) {
    throw new Error('FEEDBACK_SHEET_ID が未設定です（.env にスプレッドシート ID を指定してください）。');
  }
  const feedbacks = loadFeedback();
  if (feedbacks.length === 0) return;
  // optionalDependencies の googleapis は engines 不適合環境で未導入となり得るため遅延 require
  const { google } = require('googleapis');
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
