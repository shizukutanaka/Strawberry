// サンドボックスAPIキー発行・検証API（開発/テスト環境専用）
// 本番環境では NODE_ENV=production の場合このルートは全て 404 を返す
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const Joi = require('joi');
const { atomicWriteJSON } = require('../db/json/atomicWrite');
const { resolveDataDir } = require('../db/json/data-dir');
const { authenticateJWT, checkRole } = require('./middleware/security');
const { asyncHandler, APIError, ErrorTypes } = require('../utils/error-handler');

const SANDBOX_KEY_PATH = path.join(resolveDataDir(), 'sandbox-apikeys.json');

// サンドボックスAPIキー生成
function generateApiKey() {
  return crypto.randomBytes(24).toString('hex');
}

// サンドボックスAPIキー保存・検証
// /sandbox/apikey/verify は呼ぶたびキー一覧を readFileSync するため、
// stat 指紋ゲートで「変わった時だけ再パース」にする（i7・同規約:
// notification-settings/sla）。書き込みは atomicWriteJSON なので
// mtime で確実に検知できる。破損時は空配列（旧来の挙動）を返す。
const fs = require('fs');
let _keysStamp = undefined; // undefined=未ロード, null=ファイル不在, string=指紋
let _keysCache = null;
function _fileStamp() {
  try {
    const s = fs.statSync(SANDBOX_KEY_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch (_) {
    return null;
  }
}
function loadApiKeys() {
  const stamp = _fileStamp();
  if (stamp !== null && _keysStamp === stamp) return _keysCache;
  // ファイル不在は「キー0件」として扱いキャッシュもする（指紋は null で
  // 記録できないので毎回 stat になる — 不在時のコストは stat 1回のみで可）
  if (stamp === null) return [];
  try {
    _keysCache = JSON.parse(fs.readFileSync(SANDBOX_KEY_PATH, 'utf-8'));
    _keysStamp = stamp;
  } catch (_) {
    return _keysCache || []; // 破損時は既キャッシュ維持（初回のみ空）
  }
  return _keysCache;
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
