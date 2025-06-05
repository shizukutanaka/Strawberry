// google-calendar.js - GoogleカレンダーAPI連携ユーティリティ
// 利用予約や注文内容をGoogleカレンダーに自動登録するためのシンプルなラッパー

const { google } = require('googleapis');
const { logger } = require('./logger');

// 必要な認証情報は環境変数または設定ファイルから取得
defaultConfig = {
  clientId: process.env.GCAL_CLIENT_ID,
  clientSecret: process.env.GCAL_CLIENT_SECRET,
  redirectUri: process.env.GCAL_REDIRECT_URI,
  refreshToken: process.env.GCAL_REFRESH_TOKEN,
  calendarId: process.env.GCAL_CALENDAR_ID || 'primary',
};

function getOAuth2Client(config = {}) {
  const cfg = { ...defaultConfig, ...config };
  const oAuth2Client = new google.auth.OAuth2(
    cfg.clientId,
    cfg.clientSecret,
    cfg.redirectUri
  );
  oAuth2Client.setCredentials({ refresh_token: cfg.refreshToken });
  return oAuth2Client;
}

/**
 * Googleカレンダーに予定を追加
 * @param {Object} event - { summary, description, start, end, ... }
 * @param {Object} config - 認証・カレンダー設定
 */
async function addEventToCalendar(event, config = {}) {
  const auth = getOAuth2Client(config);
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = config.calendarId || defaultConfig.calendarId;
  try {
    const res = await calendar.events.insert({
      calendarId,
      resource: event,
    });
    logger.info('Googleカレンダー登録成功', { eventId: res.data.id });
    return res.data;
  } catch (err) {
    logger.error('Googleカレンダー登録失敗', { error: err.message });
    throw err;
  }
}

module.exports = {
  addEventToCalendar,
};
