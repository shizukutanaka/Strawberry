// src/utils/user-notify.js - ユーザー個別通知
// notification-settings API でユーザーが登録した通知チャネル（LINE/Discord/Slack/
// Telegram/Email/汎用 Webhook・イベント別 Webhook）へイベントを配送する。
// プロバイダへの「あなたの GPU に注文が入った」等のマーケットプレイスイベントに使用。
const fs = require('fs');
const path = require('path');
const { sendNotification, NotifyType } = require('./notifier');
const { logger } = require('./logger');

const SETTINGS_PATH = path.join(__dirname, '../../data/notification-settings.json');

// price-watch 等で同一ユーザーイベントを複数送信するとき、通知ごとに
// notification-settings.json を全量読み込み+パースするのを防ぐ。
// (mtimeMs, size) の stat ゲートで「ファイルが変わった時だけ再読み込み」にする。
// 設定保存側は atomicWriteJSON（rename 更新）のため mtime は必ず変わる。
let _settingsStamp = null;
let _settingsCache = null;

function loadAllSettings() {
  let stamp;
  try {
    const s = fs.statSync(SETTINGS_PATH);
    stamp = `${s.mtimeMs}:${s.size}`;
  } catch (_) {
    // ファイル不在/読めない → 設定なしとして扱う（従来と同じ結果）
    return {};
  }
  if (_settingsStamp !== stamp) {
    try {
      _settingsCache = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch (_) {
      _settingsCache = {};
    }
    _settingsStamp = stamp;
  }
  return _settingsCache;
}

// テスト用: キャッシュを明示的にクリア
function _resetSettingsCache() {
  _settingsStamp = null;
  _settingsCache = null;
}

/**
 * 設定オブジェクトから送信すべきチャネル一覧を解決する（純関数・テスト可能）。
 * enabled マップが false のチャネルは除外。イベント別 webhooks は event 一致かつ
 * enabled のもののみ。
 * @returns {Array<{type: string, options: object}>}
 */
function resolveChannels(settings, eventType) {
  if (!settings || typeof settings !== 'object') return [];
  const enabled = settings.enabled || {};
  const on = (name) => enabled[name] !== false; // 未指定は有効扱い
  const channels = [];
  if (settings.lineToken && on('line')) {
    channels.push({ type: NotifyType.LINE, options: { token: settings.lineToken } });
  }
  if (settings.discordWebhook && on('discord')) {
    channels.push({ type: NotifyType.DISCORD, options: { webhookUrl: settings.discordWebhook } });
  }
  if (settings.slackWebhook && on('slack')) {
    channels.push({ type: NotifyType.SLACK, options: { webhookUrl: settings.slackWebhook } });
  }
  if (settings.telegramBotToken && settings.telegramChatId && on('telegram')) {
    channels.push({
      type: NotifyType.TELEGRAM,
      options: { botToken: settings.telegramBotToken, chatId: settings.telegramChatId },
    });
  }
  if (settings.email && on('email')) {
    channels.push({ type: NotifyType.EMAIL, options: { to: settings.email } });
  }
  if (settings.genericWebhook && on('webhook')) {
    channels.push({ type: NotifyType.WEBHOOK, options: { webhookUrl: settings.genericWebhook } });
  }
  for (const hook of Array.isArray(settings.webhooks) ? settings.webhooks : []) {
    if (hook && hook.enabled !== false && hook.event === eventType && hook.url) {
      channels.push({ type: NotifyType.WEBHOOK, options: { webhookUrl: hook.url } });
    }
  }
  return channels;
}

/**
 * ユーザーの登録チャネルへ通知を送る（fire-and-forget、失敗はログのみ）。
 * @param {string} userId
 * @param {string} eventType - 例: 'order_created'
 * @param {string} message
 * @param {object} [extraOptions] - 例: { subject } （Email 用）
 * @returns {number} 送信を試行したチャネル数
 */
function notifyUser(userId, eventType, message, extraOptions = {}) {
  if (!userId) return 0;
  const settings = loadAllSettings()[userId];
  const channels = resolveChannels(settings, eventType);
  for (const ch of channels) {
    sendNotification(ch.type, message, { ...ch.options, ...extraOptions })
      .catch((e) => logger.warn(`notifyUser failed (${ch.type}, user=${userId}): ${e.message}`));
  }
  return channels.length;
}

module.exports = { notifyUser, resolveChannels, _resetSettingsCache };
