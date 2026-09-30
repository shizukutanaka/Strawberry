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
// 設定時（POST）と送信時（notifier.js の sendWebhookNotify → assertPublicUrl）の
// 両方で検証する多層防御。
//
// 旧実装は URL 文字列への正規表現適合のみで、以下を素通りさせていた:
//   - http://anything@127.0.0.1/    — userinfo を挟むと ^http://127. 系に非適合
//   - http://2130706433/ / http://0x7f000001/ / http://127.1/ — 数値IPv4リテラル
//   - attacker.example.com → 169.254.169.254 — DNS 解決結果を一切見ていない
//   - SSRF_ALLOW_PRIVATE_WEBHOOKS 未考慮 — 送信側は許可するのに登録側が常に拒否
// WHATWG URL パーサはホスト部を正規化する（数値IPv4は dotted-quad へ、
// userinfo は hostname から分離される）ため、new URL().hostname を
// 共有分類器 ssrf-guard.isPrivateIp で評価すれば送信側と判定が一致する。
const net = require('net');
const dnsPromises = require('dns').promises;
const { isPrivateIp } = require('../utils/ssrf-guard');

function privateWebhooksAllowed() {
  const v = process.env.SSRF_ALLOW_PRIVATE_WEBHOOKS;
  return v === 'true' || v === '1';
}

// DNS を引かずに判定できる内部ホスト名の既定ブロックリスト。
// FQDN → private IP の解決結果は POST ハンドラの resolvesToPrivateAddress で確認する。
const INTERNAL_HOSTNAME_RE = /^(?:localhost|.*\.localhost|metadata\.google\.internal|instance-data|metadata|.*\.internal|.*\.local|.*\.lan|.*\.corp|.*\.home(?:\.arpa)?)$/i;

// 同期判定: true = ブロック対象。
// リテラル IP は URL パーサで正規化した hostname を isPrivateIp へ渡し、
// 既知内部ホスト名はパターンで弾く。FQDN の解決結果はここでは扱わない。
function isBlockedWebhookTarget(url) {
  if (typeof url !== 'string') return true;
  if (privateWebhooksAllowed()) return false;
  let parsed;
  try { parsed = new URL(url); } catch (_) { return true; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  // IPv4 埋め込み IPv6（::ffff:*）は従来通り一律ブロック。
  // 16進埋め込み形（::ffff:7f00:1 等）を避けるための安全側の判断で、
  // 公開宛をこの形式で指定する正当な用途は実質存在しない。
  if (hostname.toLowerCase().startsWith('::ffff:')) return true;
  if (net.isIP(hostname)) return isPrivateIp(hostname);
  return INTERNAL_HOSTNAME_RE.test(hostname);
}

// 登録時の DNS 事前検証: FQDN が private アドレスへ解決される設定
// （127.0.0.1.nip.io のような「公開名→内部IP」）を登録時点で弾く。
// DNS 解決失敗（ENOTFOUND・一時的障害）は許容する — 送信時の assertPublicUrl が
// 権威チェックとして再解決・再判定するため、ここで拒否するとオフライン開発環境や
// まだ未開通の内部ホスト名の登録まで不能になってしまう。
async function resolvesToPrivateAddress(url) {
  if (privateWebhooksAllowed()) return false;
  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch (_) {
    return false;
  }
  if (net.isIP(hostname)) return isPrivateIp(hostname);
  try {
    const addrs = await dnsPromises.lookup(hostname, { all: true });
    return (Array.isArray(addrs) ? addrs : [addrs])
      .some((a) => isPrivateIp(a && a.address));
  } catch (_) {
    return false;
  }
}

// Joi カスタムバリデータ（URI形式 + SSRF禁止）
const safeWebhookUrl = Joi.string().uri({ scheme: ['http', 'https'] }).max(2048)
  .custom((value, helpers) => {
    if (isBlockedWebhookTarget(value)) {
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
  const raw = settings[userId] || {};
  // Mask the bearer token: a stored lineToken is a bearer credential for LINE Notify.
  // Returning it in plaintext exposes it to XSS, CSRF, and admin-log readers.
  // The caller only needs to know whether a token is set, not its value.
  const safe = { ...raw };
  if (safe.lineToken) safe.lineToken = '***';
  res.json(safe);
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
    // enabled は資料消費側（user-notify.js resolveChannels）が参照する既知の6チャネルに
    // 厳格化する。旧実装の .pattern(/.*/, Joi.boolean()) は任意キー（__proto__/constructor
    // 含む）を boolean 値であれば受理し、notification-settings.json（リポジトリ層の
    // stripDangerousKeys を経由しない別保存経路）にそのまま永続化していた。明示キー＋
    // Joi 既定の unknown:false で未知キーを 400 拒否し、実際に使われる項目だけ保存する。
    enabled: Joi.object({
      line: Joi.boolean(),
      discord: Joi.boolean(),
      slack: Joi.boolean(),
      telegram: Joi.boolean(),
      email: Joi.boolean(),
      webhook: Joi.boolean(),
    }).optional(),
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
  // 登録時の DNS 事前検証: ホスト名が private アドレスへ解決される webhook
  // （nip.io 等の公開名→内部IPマッピング）をここで弾く。同期チェックは
  // リテラル IP と既知内部名しか見ないため、FQDN の実解決結果が抜け道だった。
  // 解決失敗は許容する（resolvesToPrivateAddress 内）— 送信時の assertPublicUrl
  // が権威チェックとして再解決する多層防御。
  const candidateUrls = [
    value.discordWebhook, value.slackWebhook, value.genericWebhook,
    ...(Array.isArray(value.webhooks) ? value.webhooks.map((w) => w && w.url) : []),
  ].filter((u) => typeof u === 'string' && u.length > 0);
  for (const u of candidateUrls) {
    if (await resolvesToPrivateAddress(u)) {
      return res.status(400).json({ error: 'Webhook URL resolves to a private or internal address' });
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
