// Google Sheets API 用の共有 OAuth 認証ヘルパー。
// scripts/feedback-to-sheets.js / priority-to-sheets.js / progress-report.js が
// 同一の authorize() を複製していたのを集約したもの。
//
// scripts/credentials.json（OAuth クライアント JSON）と scripts/token.json
// （初回同意フローで取得したトークン）を読み込み OAuth2 クライアントを返す。
// 未配置・形式不正の場合は fs の ENOENT スタックではなく、次に取るべき
// 手順が分かるエラーを投げる（呼び出し側は main().catch で表示する想定）。
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

function readJsonOrThrow(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(
      `scripts/${label} がありません。` +
      'Google Cloud Console で OAuth クライアントを作成して credentials.json を配置し、' +
      '初回の OAuth 同意フローで token.json を生成してください。'
    );
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`scripts/${label} の JSON が不正です: ${e.message}`);
  }
}

async function authorize(credentialsPath = CREDENTIALS_PATH, tokenPath = TOKEN_PATH) {
  const credentials = readJsonOrThrow(credentialsPath, 'credentials.json');
  const token = readJsonOrThrow(tokenPath, 'token.json');
  // Google のダウンロード形式は installed（デスクトップ）か web（Web アプリ）の
  // どちらかのキー配下。旧実装は installed 固定で web 形式だと分解時にクラッシュした。
  const conf = credentials.installed || credentials.web;
  if (!conf || !conf.client_id || !conf.client_secret) {
    throw new Error(
      'scripts/credentials.json の形式が不正です: installed/web 配下に client_id・client_secret が必要です'
    );
  }
  const oAuth2Client = new google.auth.OAuth2(
    conf.client_id,
    conf.client_secret,
    (conf.redirect_uris || [])[0]
  );
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

module.exports = { authorize, CREDENTIALS_PATH, TOKEN_PATH };
