// 通知チャネル設定API（ユーザーごとにLINE/Discord/Slack等の通知先を管理）
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const Joi = require('joi');

const SETTINGS_PATH = path.join(__dirname, '../../data/notification-settings.json');

function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// 通知設定取得
router.get('/notification-settings/:userId', (req, res) => {
  const userId = req.params.userId;
  const settings = loadSettings();
  res.json(settings[userId] || {});
});

// 通知設定保存/更新
router.post('/notification-settings/:userId', (req, res) => {
  const userId = req.params.userId;
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
      event: Joi.string().required(), // 例: 'order_created'
      url: Joi.string().uri().required(),
      enabled: Joi.boolean().default(true),
      payloadTemplate: Joi.string().allow('').optional()
    })).optional()
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const settings = loadSettings();
  settings[userId] = value;
  saveSettings(settings);
  res.json({ success: true });
});

module.exports = { router };
