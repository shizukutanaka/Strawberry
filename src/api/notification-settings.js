// 通知チャネル設定API（ユーザーごとにLINE/Discord/Slack等の通知先を管理）
const express = require('express');
const router = express.Router();
const path = require('path');
const Joi = require('joi');
const { authenticateJWT } = require('./middleware/security');
const { atomicWriteJSON } = require('../db/json/atomicWrite');
const { asyncHandler, APIError, ErrorTypes } = require('../utils/error-handler');
const { withLock } = require('../utils/async-lock');

// 単一 JSON ファイルに全ユーザーの設定を保持するため、並行 POST/DELETE で
// read-modify-write のラストライトが他ユーザーの slot を消し飛ばす lost-update が
// 発生する。プロセスワイドな mutex で書き換えを直列化する。
const SETTINGS_LOCK = 'notification-settings:global';

// SSRF対策: プライベートIPアドレス・ループバック・メタデータサービスをブロック
// 設定時（POST）と送信時（notifier.js の sendWebhookNotify）の両方で検証（多層防御）。
const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/localhost[:/]/i,
  /^https?:\/\/127\.\d+\.\d+\.\d+[:/]/,
  /^https?:\/\/0\.0\.0\.0[:/]/,            // 0.0.0.0 = ループバック扱い
  /^https?:\/\/10\.\d+\.\d+\.\d+[:/]/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+[:/]/,
  /^https?:\/\/192\.168\.\d+\.\d+[:/]/,
  /^https?:\/\/169\.254\.\d+\.\d+[:/]/,   // AWS/Azure/GCP リンクローカルメタデータ
  /^https?:\/\/\[::1\][:/]/i,             // IPv6 loopback ::1
  /^https?:\/\/\[::ffff:/i,               // IPv4-mapped IPv6 (::ffff:127.x.x.x 等)
  /^https?:\/\/\[f[cd]/i,                 // IPv6 プライベート fc00::/7 (fc/fd) & リンクローカル fe80::/10 の一部
  /^https?:\/\/\[fe80:/i,                 // IPv6 link-local
  /^https?:\/\/metadata\.google\.internal[:/]/i,  // GCP metadata
  /^https?:\/\/instance-data[:/]/i,       // AWS 代替メタデータホスト名
];
function isSSRFUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return true;
  return PRIVATE_IP_PATTERNS.some(re => re.test(url));
}
// エクスポートして notifier.js の送信時にも再検証できるようにする
module.exports._isSSRFUrl = isSSRFUrl;

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
  if (!require('fs').existsSync(SETTINGS_PATH)) return {};
  const raw = require('fs').readFileSync(SETTINGS_PATH, 'utf-8');
  // JSON.parse を素通りさせる: parse 失敗は throw し呼び出し元で 500 にする。
  // 旧実装の catch→{} では POST が即座に上書きして全ユーザーの設定を消去していた。
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
    throw new Error('[notification-settings] settings file is corrupt: expected a JSON object');
  }
  return parsed;
}

// 全エンドポイントに JWT 認証を要求
router.use(authenticateJWT);

// :userId は必ず UUID v4 形式に絞る。これがないと admin トークンで `__proto__` や
// `constructor` のような特殊キーを保存でき、Object.keys 走査時にプロトタイプ
// メソッドと衝突して notifier の通知配信が壊れる。
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function _requireUuidParam(req, res, next) {
  if (!_UUID_RE.test(req.params.userId || '')) {
    return res.status(400).json({ error: 'userId must be a UUID v4' });
  }
  next();
}
router.use('/notification-settings/:userId', _requireUuidParam);

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
    // LINE Notify トークンは英数字・アンダースコア・ハイフンのみの固定長文字列。
    // 制約がないと CRLF シーケンス(\r\n)を含む値を Bearer ヘッダに注入でき、
    // 送信先 api.line.me へのリクエストにヘッダを追加するリスクがある。
    lineToken: Joi.string().allow('').pattern(/^[A-Za-z0-9_-]{30,60}$/).max(60).optional(),
    discordWebhook: safeWebhookUrl.allow('').optional(),
    slackWebhook: safeWebhookUrl.allow('').optional(),
    // Telegram bot token は notifier 側で `https://api.telegram.org/bot${token}/sendMessage`
    // のパス組み立てに使われる。値に '/' や '?' が混入すると経路再解釈・SSRF誘発の
    // 可能性があるため、Telegram の公式仕様（数字ID:35文字英数字_- ）に厳格に絞り込む。
    telegramBotToken: Joi.string().pattern(/^\d{6,12}:[A-Za-z0-9_-]{30,45}$/).allow('').optional(),
    // chat_id は数値（個人/チャネル）または '@channelname'。それ以外は拒否。
    telegramChatId: Joi.string().pattern(/^-?\d+$|^@[A-Za-z0-9_]{5,32}$/).allow('').optional(),
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
  // payloadTemplate はサーバー側で JSON.parse されてから webhook に送信される。
  // 不正な JSON を保存すると送信時に例外・通知ループ停止を引き起こすため、
  // 保存時点で構文チェックを行い悪意ある Stored-JSON-Injection も防ぐ。
  if (value.webhooks) {
    for (const wh of value.webhooks) {
      if (wh.payloadTemplate && wh.payloadTemplate.trim() !== '') {
        try {
          JSON.parse(wh.payloadTemplate.replace(/\$\{message\}/g, '"__probe__"'));
        } catch (e) {
          return res.status(400).json({ error: `payloadTemplate is not valid JSON: ${e.message}` });
        }
      }
    }
  }
  await withLock(SETTINGS_LOCK, async () => {
    const settings = loadSettings();
    settings[userId] = value;
    atomicWriteJSON(SETTINGS_PATH, settings);
  });
  res.json({ success: true });
}));

// 通知設定削除（自分のみ、管理者は任意ユーザー）
router.delete('/notification-settings/:userId', asyncHandler(async (req, res) => {
  const userId = req.params.userId;
  if (req.user.id !== userId && req.user.role !== 'admin') {
    throw new APIError(ErrorTypes.FORBIDDEN, 'Access denied', 403);
  }
  const result = await withLock(SETTINGS_LOCK, async () => {
    const settings = loadSettings();
    if (!settings[userId]) return { notFound: true };
    delete settings[userId];
    atomicWriteJSON(SETTINGS_PATH, settings);
    return { notFound: false };
  });
  if (result.notFound) return res.status(404).json({ error: 'Notification settings not found' });
  res.json({ success: true });
}));

module.exports = { router };
