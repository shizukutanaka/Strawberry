// notifier.js - 外部通知サービス抽象化レイヤ
// 各種通知（LINE, Discord, Slack, Telegram, Email, Webhook等）を一元的に扱うユーティリティ
// 必要に応じて各サービスごとに個別モジュールを追加・拡張可能

const axios = require('axios');
const { logger } = require('./logger');

// 通知タイプ定義
const NotifyType = {
  LINE: 'line',
  DISCORD: 'discord',
  SLACK: 'slack',
  TELEGRAM: 'telegram',
  EMAIL: 'email',
  WEBHOOK: 'webhook',
};

// メイン通知送信関数（type, message, options）
const { sendEmailNotification } = require('./email');
async function sendNotification(type, message, options = {}) {
  try {
    switch (type) {
      case NotifyType.LINE:
        return await sendLineNotify(message, options);
      case NotifyType.DISCORD:
        return await sendDiscordNotify(message, options);
      case NotifyType.SLACK:
        return await sendSlackNotify(message, options);
      case NotifyType.TELEGRAM:
        return await sendTelegramNotify(message, options);
      case NotifyType.EMAIL:
        await sendEmailNotification({
          to: options.to,
          subject: options.subject || 'Strawberry Marketplace 通知',
          text: options.text || message,
          html: options.html,
        }, options.config);
        break;
      case NotifyType.WEBHOOK:
        return await sendWebhookNotify(message, options);
      default:
        throw new Error(`Unknown notification type: ${type}`);
    }
  } catch (err) {
    logger.error(`通知送信失敗(${type}): ${err.message}`);
    throw err;
  }
}

// LINE Notify
async function sendLineNotify(message, { token }) {
  if (!token) throw new Error('LINEトークン未設定');
  const res = await axios.post('https://notify-api.line.me/api/notify',
    new URLSearchParams({ message }),
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  return res.data;
}

// Discord Webhook
async function sendDiscordNotify(message, { webhookUrl }) {
  if (!webhookUrl) throw new Error('Discord Webhook URL未設定');
  const res = await axios.post(webhookUrl, { content: message });
  return res.data;
}

// Slack Webhook
async function sendSlackNotify(message, { webhookUrl }) {
  if (!webhookUrl) throw new Error('Slack Webhook URL未設定');
  const res = await axios.post(webhookUrl, { text: message });
  return res.data;
}

// Telegram Bot
async function sendTelegramNotify(message, { botToken, chatId }) {
  if (!botToken || !chatId) throw new Error('Telegram Bot情報未設定');
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await axios.post(url, { chat_id: chatId, text: message });
  return res.data;
}

// Email（SendGrid/Mailgun等は別途実装）
async function sendEmailNotify(message, { to, subject = '通知', from, sendFunc }) {
  if (!sendFunc) throw new Error('メール送信関数未設定');
  return await sendFunc({ to, subject, text: message, from });
}

// 汎用Webhook
async function sendWebhookNotify(message, { webhookUrl, payload = {} }) {
  if (!webhookUrl) throw new Error('Webhook URL未設定');
  const res = await axios.post(webhookUrl, { message, ...payload });
  return res.data;
}

module.exports = {
  sendNotification,
  NotifyType,
};
