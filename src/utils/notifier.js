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
const fs = require('fs');
const path = require('path');

async function sendNotification(typeOrUserId, message, options = {}) {
  // typeOrUserIdがユーザーIDの場合、多段通知
  if (typeof typeOrUserId === 'string' && typeOrUserId.startsWith('user_')) {
    // 設定ファイルから通知設定を取得
    const userId = typeOrUserId;
    const settingsPath = path.resolve(__dirname, '../api/notification-settings.json');
    let settings = {};
    try {
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))[userId] || {};
      }
    } catch {}
    const enabled = settings.enabled || {};
    const tasks = [];
    if (enabled.line && settings.lineToken) {
      tasks.push(sendNotification(NotifyType.LINE, message, { token: settings.lineToken }));
    }
    if (enabled.discord && settings.discordWebhook) {
      tasks.push(sendNotification(NotifyType.DISCORD, message, { webhookUrl: settings.discordWebhook }));
    }
    if (enabled.slack && settings.slackWebhook) {
      tasks.push(sendNotification(NotifyType.SLACK, message, { webhookUrl: settings.slackWebhook }));
    }
    if (enabled.telegram && settings.telegramBotToken && settings.telegramChatId) {
      tasks.push(sendNotification(NotifyType.TELEGRAM, message, { botToken: settings.telegramBotToken, chatId: settings.telegramChatId }));
    }
    if (enabled.email && settings.email) {
      tasks.push(sendNotification(NotifyType.EMAIL, message, { to: settings.email }));
    }
    if (enabled.webhook && settings.genericWebhook) {
      tasks.push(sendNotification(NotifyType.WEBHOOK, message, { webhookUrl: settings.genericWebhook }));
    }
    // 柔軟Webhook拡張: webhooks配列
    if (Array.isArray(settings.webhooks)) {
      const event = options.event || null;
      for (const wh of settings.webhooks) {
        if (wh.enabled !== false && (!event || wh.event === event) && wh.url) {
          // payloadテンプレートがあれば適用、なければデフォルト
          let payload = { message };
          if (wh.payloadTemplate) {
            try {
              // テンプレートは ${message} 置換のみサポート
              payload = JSON.parse(wh.payloadTemplate.replace(/\$\{message\}/g, message));
            } catch {
              payload = { message };
            }
          }
          tasks.push(sendNotification(NotifyType.WEBHOOK, message, { webhookUrl: wh.url, payload }));
        }
      }
    }
    return Promise.all(tasks);
  }
  // 既存のtype/message/options送信
  try {
    switch (typeOrUserId) {
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
        throw new Error(`Unknown notification type: ${typeOrUserId}`);
    }
  } catch (err) {
    logger.error(`通知送信失敗(${typeOrUserId}): ${err.message}`);
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
