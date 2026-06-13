// 通知チャネル設定API（ユーザーごとにLINE/Discord/Slack等の通知先を管理）
const express = require('express');
const router = express.Router();
const path = require('path');
const Joi = require('joi');
const { authenticateJWT } = require('./middleware/security');
const { atomicWriteJSON } = require('../db/json/atomicWrite');
const { asyncHandler, APIError, ErrorTypes } = require('../utils/error-handler');

// SSRF対策: プライベートIPアドレス・ループバック・メタデータサービスをブロック
const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/localhost[:/]/i,
  /^https?:\/\/127\.\d+\.\d+\.\d+[:/]/,
  /^https?:\/\/10\.\d+\.\d+\.\d+[:/]/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+[:/]/,
  /^https?:\/\/192\.168\.\d+\.\d+[:/]/,
  /^https?:\/\/169\.254\.\d+\.\d+[:/]/,  // AWS metadata
  /^https?:\/\/\[?::[1f]\]?[:/]/i,        // ::1, ::ffff IPv6 loopback
];
function isSSRFUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return true;
  return PRIVATE_IP_PATTERNS.some(re => re.test(url));
}

// Joi カスタムバリデータ（URI形式 + SSRF禁止）
const safeWebhookUrl = Joi.string().uri({ scheme: ['http', 'https'] }).max(2048)
  .custom((value, helpers) => {
    if (isSSRFUrl(value)) {
      return helpers.error('any.invalid');
    }
    return value;
  }).messages({ 'any.invalid': 'Webhook URL must not point to private or internal addresses' });

const SETTINGS_PATH = path.join(__dirname, '../../data/notification-settings.json');

function loadSettings() {
  try {
    return require('fs').existsSync(SETTINGS_PATH)
      ? JSON.parse(require('fs').readFileSync(SETTINGS_PATH, 'utf-8'))
      : {};
  } catch (_) {
    return {};
  }
}

// 全エンドポイントに JWT 認証を要求
router.use(authenticateJWT);

// 通知設定取得（自分のみ、管理者は任意ユーザー）
router.get('/notification-settings/:userId', asyncHandler(async (req, res) => {
  const userId = req.params.userId;
  if (req.user.id !== userId && req.user.role !== 'admin') {
    throw new APIError(ErrorTypes.FORBIDDEN, 'Access denied', 403);
  }
  const settings = loadSettings();
  res.json(settings[userId] || {});
}));

// 通知設定保存/更新（自分のみ、管理者は任意ユーザー）
router.post('/notification-settings/:userId', asyncHandler(async (req, res) => {
  const userId = req.params.userId;
  if (req.user.id !== userId && req.user.role !== 'admin') {
    throw new APIError(ErrorTypes.FORBIDDEN, 'Access denied', 403);
  }
  const schema = Joi.object({
    lineToken: Joi.string().allow('').optional(),
    discordWebhook: safeWebhookUrl.allow('').optional(),
    slackWebhook: safeWebhookUrl.allow('').optional(),
    telegramBotToken: Joi.string().allow('').optional(),
    telegramChatId: Joi.string().allow('').optional(),
    email: Joi.string().email().allow('').optional(),
    genericWebhook: safeWebhookUrl.allow('').optional(),
    enabled: Joi.object().pattern(/.*/, Joi.boolean()).optional(),
    webhooks: Joi.array().items(Joi.object({
      event: Joi.string().max(64).required(),
      url: safeWebhookUrl.required(),
      enabled: Joi.boolean().default(true),
      payloadTemplate: Joi.string().max(4096).allow('').optional()
    })).max(20).optional()
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const settings = loadSettings();
  settings[userId] = value;
  atomicWriteJSON(SETTINGS_PATH, settings);
  res.json({ success: true });
}));

// 通知設定削除（自分のみ、管理者は任意ユーザー）
router.delete('/notification-settings/:userId', asyncHandler(async (req, res) => {
  const userId = req.params.userId;
  if (req.user.id !== userId && req.user.role !== 'admin') {
    throw new APIError(ErrorTypes.FORBIDDEN, 'Access denied', 403);
  }
  const settings = loadSettings();
  if (!settings[userId]) return res.status(404).json({ error: 'Notification settings not found' });
  delete settings[userId];
  atomicWriteJSON(SETTINGS_PATH, settings);
  res.json({ success: true });
}));

module.exports = { router };
