// 多重通知・冗長化通知ユーティリティ
const axios = require('axios');
const { logger } = require('./logger');

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
    try {
      if (ch.type === 'line') {
        await axios.post(ch.url, `message=${encodeURIComponent(message)}`, {
          headers: { 'Authorization': `Bearer ${ch.token}`, 'Content-Type': 'application/x-www-form-urlencoded' }
        });
      } else if (ch.type === 'discord' || ch.type === 'slack' || ch.type === 'webhook') {
        await axios.post(ch.url, { content: message });
      } else if (ch.type === 'telegram') {
        await axios.post(`${ch.url}/bot${ch.token}/sendMessage`, {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: message
        });
      } else if (ch.type === 'email') {
        await axios.post(ch.url, { to: process.env.EMAIL_TO, subject: options.subject || 'Strawberry通知', text: message }, {
          headers: { 'Authorization': `Bearer ${ch.token}` }
        });
      }
      notified = true;
      logger.info(`通知成功: ${ch.type}`);
      break; // どこか1つ成功したら終了
    } catch (err) {
      errors.push({ channel: ch.type, error: err.message });
      logger.warn(`通知失敗: ${ch.type} (${err.message})`);
      continue; // 次のチャネルへ切替
    }
  }
  if (!notified) {
    logger.error('全通知チャネルで送信失敗', { message, errors });
    throw new Error('全通知チャネルで送信失敗');
  }
}

module.exports = { resilientNotify };
