// サンドボックスAPIキー発行・検証API（開発/検証用）
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Joi = require('joi');

const SANDBOX_KEY_PATH = path.join(__dirname, '../../data/sandbox-apikeys.json');

// サンドボックスAPIキー生成
function generateApiKey() {
  return crypto.randomBytes(24).toString('hex');
}

// サンドボックスAPIキー保存・検証
function loadApiKeys() {
  if (!fs.existsSync(SANDBOX_KEY_PATH)) return [];
  return JSON.parse(fs.readFileSync(SANDBOX_KEY_PATH, 'utf-8'));
}
function saveApiKeys(keys) {
  fs.writeFileSync(SANDBOX_KEY_PATH, JSON.stringify(keys, null, 2));
}
function addApiKey(userId) {
  const keys = loadApiKeys();
  const key = generateApiKey();
  keys.push({ userId, key, created: new Date().toISOString() });
  saveApiKeys(keys);
  return key;
}
function isValidApiKey(key) {
  const keys = loadApiKeys();
  return keys.some(k => k.key === key);
}

// APIキー発行エンドポイント
router.post('/sandbox/apikey', (req, res) => {
  const schema = Joi.object({ userId: Joi.string().required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const key = addApiKey(value.userId);
  res.json({ apiKey: key });
});

// APIキー検証エンドポイント
router.post('/sandbox/apikey/verify', (req, res) => {
  const schema = Joi.object({ apiKey: Joi.string().required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const valid = isValidApiKey(value.apiKey);
  res.json({ valid });
});

module.exports = { router, generateApiKey, isValidApiKey };
