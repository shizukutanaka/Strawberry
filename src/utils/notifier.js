// notifier.js - 外部通知サービス抽象化レイヤ
// 各種通知（LINE, Discord, Slack, Telegram, Email, Webhook等）を一元的に扱うユーティリティ
// 必要に応じて各サービスごとに個別モジュールを追加・拡張可能

const axios = require('axios');
const { logger } = require('./logger');
// 送信時 SSRF ガード: ホスト名を実際に名前解決して内部/予約アドレスを遮断する。
const { assertPublicUrl } = require('./ssrf-guard');

// Webhook/外部HTTP呼び出し共通安全設定は ./http-safe-config.js に集約
// （email.js・resilient-notify.js と同一の既定を共有する）。
const { AXIOS_SAFE_CONFIG } = require('./http-safe-config');

// 通知タイプ定義
const NotifyType = {
  LINE: 'line',               // 廃止: LINE Notify は 2025-03-31 にサービス終了
  LINE_MESSAGING: 'line_messaging', // 後継: LINE Messaging API（push メッセージ）
  DISCORD: 'discord',
  SLACK: 'slack',
  TELEGRAM: 'telegram',
  EMAIL: 'email',
  WEBHOOK: 'webhook',
};

// メイン通知送信関数（type, message, options）
const { sendEmailNotification } = require('./email');

// ユーザー個別の多段通知は src/utils/user-notify.js の notifyUser が担う。
// （旧実装は 'user_*' プレフィックス判定でこの関数内に多段経路を持っていたが、
// 実際のユーザーIDは UUID v4 で 'user_' 始まりにならないため到達不能だった。
// 通知設定の読み込み・チャネル解決・イベント別 webhook 選択は user-notify.js 側が
// resolveChannels で行い、ここはチャネル種別への直送のみを担当する。）
async function sendNotification(typeOrUserId, message, options = {}) {
  try {
    switch (typeOrUserId) {
      case NotifyType.LINE:
        return await sendLineNotify(message, options);
      case NotifyType.LINE_MESSAGING:
        return await sendLineMessagingNotify(message, options);
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

// LINE Notify（廃止）
// notify-api.line.me は 2025-03-31 にサービス終了 — 呼出しても必ず失敗するため
// HTTP 送信は行わず即座に移行案内付きのエラーを返す（呼出側の catch で通知失敗として処理される）。
// 後継は LINE Messaging API（sendLineMessagingNotify）。
async function sendLineNotify(message, { token } = {}) {
  throw new Error(
    'LINE Notify は 2025-03-31 にサービス終了しました（notify-api.line.me は応答しません）。' +
    'LINE Messaging API へ移行してください: NotifyType.LINE_MESSAGING + { token: <channel access token>, to: <userId/groupId> }'
  );
}

// LINE Messaging API（LINE Notify の公式後継）
// POST https://api.line.me/v2/bot/message/push
//   Authorization: Bearer <channel access token>
//   { to: <userId|groupId|roomId>, messages: [{ type: 'text', text }] }
async function sendLineMessagingNotify(message, { token, to } = {}) {
  if (!token) throw new Error('LINE Messaging API チャネルアクセストークン未設定');
  if (!to) throw new Error('LINE Messaging API 送信先（to: userId/groupId）未設定');
  return withRetry(async () => {
    const res = await axios.post('https://api.line.me/v2/bot/message/push',
      { to, messages: [{ type: 'text', text: String(message).slice(0, 5000) }] },
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

// 指数バックオフ付きリトライ（一時的なネットワーク障害 / 5xx に対応）。
// 遅延は full jitter（AWS Architecture Blog「Exponential Backoff And Jitter」流）。
// 固定指数バックオフだと一括障害・一斉通知（price-watch 等）の失敗リトライが
// 同期化してサンダリングハードを起こすため、0〜指数上限の一様乱数で分散させる。
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 30_000 } = {}) {
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
        const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
        await new Promise(r => setTimeout(r, Math.random() * cap));
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
