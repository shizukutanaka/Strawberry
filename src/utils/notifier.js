// notifier.js - 外部通知サービス抽象化レイヤ
// 各種通知（LINE, Discord, Slack, Telegram, Email, Webhook等）を一元的に扱うユーティリティ
// 必要に応じて各サービスごとに個別モジュールを追加・拡張可能

const axios = require('axios');
const { logger } = require('./logger');
// 送信時 SSRF ガード: ホスト名を実際に名前解決して内部/予約アドレスを遮断する。
const { assertPublicUrl } = require('./ssrf-guard');

// Webhook/外部HTTP呼び出し共通安全設定。
// タイムアウトなし・レスポンスサイズ無制限だと、攻撃者管理のエンドポイントが
// 無限レスポンスを返すことで Node.js ヒープを枯渇させ DoS できる。
//
// maxRedirects:0 が SSRF 対策上重要: assertPublicUrl() は「最初の URL」のホスト名を
// 名前解決して内部アドレスを遮断するが、axios 既定（maxRedirects:5）だと、検証を通過した
// 公開 URL が 30x で http://127.0.0.1/ や 169.254.169.254（クラウドメタデータ）へ
// リダイレクトした場合に axios が自動追従し、ガードを迂回されてしまう。
// Webhook 送信先（Discord/Slack/Telegram/汎用）は正常時 2xx を直接返しリダイレクトしないため、
// リダイレクトを一切追わない（30x はエラー扱い）ことで攻撃面を塞ぐ。
const AXIOS_SAFE_CONFIG = Object.freeze({
  timeout: 10_000,               // 10 秒でタイムアウト
  maxContentLength: 1_048_576,   // レスポンスボディ上限 1 MiB
  maxBodyLength: 1_048_576,      // リクエストボディ上限 1 MiB
  maxRedirects: 0,               // リダイレクト追従禁止（SSRF リダイレクト迂回を遮断）
});

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
    const settingsPath = path.resolve(__dirname, '../../data/notification-settings.json');
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
              // テンプレートは ${message} 置換のみサポート。
              // JSON.stringify でエスケープして注入攻撃・不正 JSON を防ぐ。
              const safeMsg = JSON.stringify(String(message)).slice(1, -1);
              payload = JSON.parse(wh.payloadTemplate.replace(/\$\{message\}/g, safeMsg));
            } catch (e) {
              logger.warn(`Webhook payloadTemplate parse failed (url=${wh.url}): ${e.message}`);
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
        return await sendEmailNotification({
          to: options.to,
          subject: options.subject || 'Strawberry Marketplace 通知',
          text: options.text || message,
          html: options.html,
        }, options.config);
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
  return withRetry(async () => {
    const res = await axios.post('https://notify-api.line.me/api/notify',
      new URLSearchParams({ message }),
      { headers: { 'Authorization': `Bearer ${token}` }, ...AXIOS_SAFE_CONFIG }
    );
    return res.data;
  });
}

// Discord Webhook
async function sendDiscordNotify(message, { webhookUrl }) {
  if (!webhookUrl) throw new Error('Discord Webhook URL未設定');
  await assertPublicUrl(webhookUrl); // 送信時に名前解決して内部アドレスを遮断
  return withRetry(async () => {
    const res = await axios.post(webhookUrl, { content: message }, AXIOS_SAFE_CONFIG);
    return res.data;
  });
}

// Slack Webhook
async function sendSlackNotify(message, { webhookUrl }) {
  if (!webhookUrl) throw new Error('Slack Webhook URL未設定');
  await assertPublicUrl(webhookUrl); // 送信時に名前解決して内部アドレスを遮断
  return withRetry(async () => {
    const res = await axios.post(webhookUrl, { text: message }, AXIOS_SAFE_CONFIG);
    return res.data;
  });
}

// Telegram Bot
// 注: botToken/chatId は notification-settings.js の Joi で厳格パターン検証済み
// （`^\d{6,12}:[A-Za-z0-9_-]{30,45}$` / `^-?\d+$|^@[A-Za-z0-9_]{5,32}$`）。
// 多層防御として送信時にも先頭文字種を再検査し、URL 経路再解釈・SSRF を遮断する。
async function sendTelegramNotify(message, { botToken, chatId }) {
  if (!botToken || !chatId) throw new Error('Telegram Bot情報未設定');
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,45}$/.test(botToken)) {
    throw new Error('Telegram botToken format invalid');
  }
  if (!/^-?\d+$|^@[A-Za-z0-9_]{5,32}$/.test(String(chatId))) {
    throw new Error('Telegram chatId format invalid');
  }
  return withRetry(async () => {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await axios.post(url, { chat_id: chatId, text: message }, AXIOS_SAFE_CONFIG);
    return res.data;
  });
}

// Email（SendGrid/Mailgun等は別途実装）
async function sendEmailNotify(message, { to, subject = '通知', from, sendFunc }) {
  if (!sendFunc) throw new Error('メール送信関数未設定');
  return await sendFunc({ to, subject, text: message, from });
}

// 指数バックオフ付きリトライ（一時的なネットワーク障害 / 5xx に対応）
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // 4xx はクライアントエラーのためリトライしない
      const status = err.response && err.response.status;
      if (status && status >= 400 && status < 500) throw err;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastError;
}

// 汎用Webhook
// 送信時に SSRF チェックを行う（設定保存時の regex バリデーションに加えた多層防御）。
// assertPublicUrl は名前解決まで行い、旧 regex チェックの上位互換（リテラル private IP・
// DNS リバインディング・内部ホスト名・代替エンコードを一括で遮断）。よって冗長な
// regex 前段（循環 require に依存し脆かった）は廃し、本ガード一本に集約する。
async function sendWebhookNotify(message, { webhookUrl, payload = {} }) {
  if (!webhookUrl) throw new Error('Webhook URL未設定');
  await assertPublicUrl(webhookUrl);
  return withRetry(async () => {
    const res = await axios.post(webhookUrl, { message, ...payload }, AXIOS_SAFE_CONFIG);
    return res.data;
  });
}

module.exports = {
  sendNotification,
  NotifyType,
  withRetry,
};
