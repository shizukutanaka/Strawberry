// 通知チャネル設定API（ユーザーごとにLINE/Discord/Slack等の通知先を管理）
const express = require('express');
const router = express.Router();
const path = require('path');
const Joi = require('joi');
const { authenticateJWT } = require('./middleware/security');
const { atomicWriteJSON } = require('../db/json/atomicWrite');
const { asyncHandler, APIError, ErrorTypes } = require('../utils/error-handler');

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
    discordWebhook: Joi.string().uri().allow('').optional(),
    slackWebhook: Joi.string().uri().allow('').optional(),
    telegramBotToken: Joi.string().allow('').optional(),
    telegramChatId: Joi.string().allow('').optional(),
    email: Joi.string().email().allow('').optional(),
    genericWebhook: Joi.string().uri().allow('').optional(),
    enabled: Joi.object().pattern(/.*/, Joi.boolean()).optional(), // 各チャネルON/OFF
    webhooks: Joi.array().items(Joi.object({
      event: Joi.string().max(64).required(),
      url: Joi.string().uri().max(2048).required(),
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
