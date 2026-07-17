// サンドボックスAPIキー発行・検証API（開発/テスト環境専用）
// 本番環境では NODE_ENV=production の場合このルートは全て 404 を返す
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const Joi = require('joi');
const { atomicWriteJSON } = require('../db/json/atomicWrite');
const { authenticateJWT, checkRole } = require('./middleware/security');
const { asyncHandler, APIError, ErrorTypes } = require('../utils/error-handler');

const SANDBOX_KEY_PATH = path.join(__dirname, '../../data/sandbox-apikeys.json');

// サンドボックスAPIキー生成
function generateApiKey() {
  return crypto.randomBytes(24).toString('hex');
}

// サンドボックスAPIキー保存・検証
function loadApiKeys() {
  try {
    return require('fs').existsSync(SANDBOX_KEY_PATH)
      ? JSON.parse(require('fs').readFileSync(SANDBOX_KEY_PATH, 'utf-8'))
      : [];
  } catch (_) {
    return [];
  }
}
function addApiKey(userId) {
  const keys = loadApiKeys();
  const key = generateApiKey();
  keys.push({ userId, key, created: new Date().toISOString() });
  atomicWriteJSON(SANDBOX_KEY_PATH, keys);
  return key;
}
function isValidApiKey(key) {
  return loadApiKeys().some(k => k.key === key);
}

// 本番環境では無効化
router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

// APIキー発行エンドポイント（管理者のみ）
router.post('/sandbox/apikey', authenticateJWT, checkRole(['admin']), asyncHandler(async (req, res) => {
  const schema = Joi.object({ userId: Joi.string().required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const key = addApiKey(value.userId);
  res.json({ apiKey: key });
}));

// APIキー検証エンドポイント（管理者のみ）
router.post('/sandbox/apikey/verify', authenticateJWT, checkRole(['admin']), asyncHandler(async (req, res) => {
  const schema = Joi.object({ apiKey: Joi.string().required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const valid = isValidApiKey(value.apiKey);
  res.json({ valid });
}));

module.exports = { router, generateApiKey, isValidApiKey };
