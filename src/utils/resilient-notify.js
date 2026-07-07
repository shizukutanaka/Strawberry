// 多重通知・冗長化通知ユーティリティ
const axios = require('axios');
const { logger } = require('./logger');
const { assertPublicUrl } = require('./ssrf-guard');

// 送信共通安全設定。maxRedirects:0 が重要:
// assertPublicUrl() は最初の URL のみ検証するため、リダイレクト追従を許すと検証通過済みの
// 公開 URL が 30x で内部アドレス（127.0.0.1 / 169.254.169.254 等）へ誘導でき SSRF ガードを
// 迂回される。タイムアウト・サイズ上限と併せてリダイレクトを一切追わない。
const SAFE_CONFIG = Object.freeze({
  timeout: 10_000,
  maxContentLength: 1_048_576,
  maxBodyLength: 1_048_576,
  maxRedirects: 0,
});

const CHANNELS = [
  { type: 'line', url: process.env.LINE_NOTIFY_URL, token: process.env.LINE_TOKEN },
  { type: 'discord', url: process.env.DISCORD_WEBHOOK },
  { type: 'slack', url: process.env.SLACK_WEBHOOK },
  { type: 'telegram', url: process.env.TELEGRAM_API_URL, token: process.env.TELEGRAM_BOT_TOKEN },
  { type: 'email', url: process.env.EMAIL_API_URL, token: process.env.EMAIL_API_KEY },
  { type: 'webhook', url: process.env.GENERIC_WEBHOOK }
];

/**
 * 冗長化・多重チャネル通知（障害時は自動リトライ/切替）
 * @param {string} message
 * @param {object} [options]
 * @returns {Promise<void>}
 */
async function resilientNotify(message, options = {}) {
  let notified = false;
  let errors = [];
  for (const ch of CHANNELS) {
    if (!ch.url) continue;
    // Env-var URLs are admin-configured but could point to internal services if the
    // deployment pipeline is compromised. Guard against SSRF before dispatching.
    // Strip newlines from channel type and error messages before logging to prevent
    // log injection: an attacker-controlled webhook response body in err.message
    // or a poisoned ch.type could otherwise forge arbitrary log lines.
    const safeType = String(ch.type || '').replace(/[\n\r]/g, '');
    try {
      await assertPublicUrl(ch.url);
    } catch (ssrfErr) {
      const safeErrMsg = String(ssrfErr.message || '').replace(/[\n\r]/g, ' ');
      logger.warn(`SSRF blocked: skipping ${safeType} notification channel (${safeErrMsg})`);
      errors.push({ channel: ch.type, error: `SSRF blocked: ${ssrfErr.message}` });
      continue;
    }
    try {
      if (ch.type === 'line') {
        await axios.post(ch.url, `message=${encodeURIComponent(message)}`, {
          headers: { 'Authorization': `Bearer ${ch.token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          ...SAFE_CONFIG,
        });
      } else if (ch.type === 'discord' || ch.type === 'slack' || ch.type === 'webhook') {
        await axios.post(ch.url, { content: message }, SAFE_CONFIG);
      } else if (ch.type === 'telegram') {
        await axios.post(`${ch.url}/bot${ch.token}/sendMessage`, {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: message
        }, SAFE_CONFIG);
      } else if (ch.type === 'email') {
        await axios.post(ch.url, { to: process.env.EMAIL_TO, subject: options.subject || 'Strawberry通知', text: message }, {
          headers: { 'Authorization': `Bearer ${ch.token}` },
          ...SAFE_CONFIG,
        });
      }
      notified = true;
      logger.info(`通知成功: ${ch.type}`);
      break; // どこか1つ成功したら終了
    } catch (err) {
      const safeErrMsg = String(err.message || '').replace(/[\n\r]/g, ' ');
      errors.push({ channel: ch.type, error: err.message });
      logger.warn(`通知失敗: ${safeType} (${safeErrMsg})`);
      continue; // 次のチャネルへ切替
    }
  }
  if (!notified) {
    logger.error('全通知チャネルで送信失敗', { message, errors });
    throw new Error('全通知チャネルで送信失敗');
  }
}

module.exports = { resilientNotify };
