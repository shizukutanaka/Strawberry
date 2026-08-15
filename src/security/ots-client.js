// src/security/ots-client.js
// OpenTimestamps カレンダー・クライアント（研究ドキュメント §18「監査ログの対外証明」）。
//
// 監査ログの Merkle root（src/security/audit-anchor.js）を公開タイムスタンプへ提出する。
// OpenTimestamps は多数の digest をカレンダーサーバ側で Merkle 集約し、最終的に単一の
// Bitcoin トランザクションへコミットする方式（Peter Todd）。1 件あたりの提出コストが
// ほぼゼロなので、定期アンカーの提出先として現実的な唯一の選択肢に近い。
//
// 系譜: Haber & Stornetta (1991) が示したハッシュ連鎖＋分散した信頼、RFC 3161 の TSA
// （信頼された第三者）モデル、そして OTS はその TSA を Bitcoin の PoW に置き換えたもの。
//
// --- 設計判断: レシートは「不透明」に保存する -------------------------------
// 本モジュールは OTS のバイナリ証明ツリーを自前でパース・検証しない。カレンダーが返す
// バイト列をそのまま base64 で保存するだけである。
//   理由: 受領バイト列を検証するには証明ツリーのデシリアライズと Bitcoin ブロックヘッダ
//   照合が必要で、それを自前実装したうえで「Bitcoin タイムスタンプを検証済み」と称するのは
//   overclaim になる。レシートを verbatim で保持すれば、第三者は標準の `ots` CLI /
//   javascript-opentimestamps で自分で検証・アップグレードできるため、非否認性という
//   目的は達成される。「誰が検証するか」を運営から第三者へ移すのがこの機能の主旨でもある。
// そのため Bitcoin 確定待ちのアップグレード取得（GET /timestamp/{commitment}）も
// 本バージョンの対象外とする（commitment の算出に提出レスポンスのパースが要るため）。
// レシート保有者は誰でも `ots upgrade` を自分で実行できるので機能上の欠落にはならない。
// ---------------------------------------------------------------------------
const axios = require('axios');
const { assertPublicUrl } = require('../utils/ssrf-guard');
const { logger } = require('../utils/logger');
const { appendAuditLog } = require('../utils/audit-log');

// 既定のカレンダー群。複数へ冗長提出するのは本質的な要件であってオプションではない:
// 単一のカレンダー運営者が Strawberry 運営者と結託すれば「後から都合よくタイムスタンプを
// 作り直す」ことが可能になり、外部アンカリングの意味が消える。
const DEFAULT_CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
];

const DEFAULT_TIMEOUT_MS = 10_000;
// 悪意ある/故障したカレンダーが巨大なレスポンスを流し込んでメモリを食い潰すのを防ぐ。
// 正常な OTS のペンディング・タイムスタンプは通常 数百バイト〜数 KB。
const MAX_RECEIPT_BYTES = 64 * 1024;

/** OTS 提出が有効か（既定は無効 — 外部ネットワークへ出る機能はオプトイン）。 */
function isEnabled() {
  const v = process.env.AUDIT_ANCHOR_OTS_ENABLED;
  return v === '1' || v === 'true';
}

/** 提出先カレンダー一覧（AUDIT_ANCHOR_CALENDARS でカンマ区切り上書き）。 */
function calendars() {
  const raw = process.env.AUDIT_ANCHOR_CALENDARS;
  if (!raw) return DEFAULT_CALENDARS.slice();
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 末尾スラッシュを正規化して digest 提出 URL を作る。 */
function digestUrl(calendar) {
  return `${String(calendar).replace(/\/+$/, '')}/digest`;
}

/**
 * 1 つのカレンダーへ digest を提出する。
 * 例外は投げず、必ず結果レコードを返す（fail-soft）。
 * @param {string} calendar
 * @param {Buffer} digest 生の 32 バイト
 * @param {object} deps { httpPost, resolver, now } テスト注入
 * @returns {Promise<object>} レシートレコード
 */
async function submitToCalendar(calendar, digest, deps = {}) {
  const {
    httpPost = axios.post,
    resolver,
    now = () => new Date().toISOString(),
    timeoutMs = Number(process.env.AUDIT_ANCHOR_OTS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  } = deps;

  const base = { calendar, submittedAt: now() };
  const url = digestUrl(calendar);

  // SSRF ガード: カレンダー URL は env から来るため、内部アドレスへ向けられる可能性がある。
  // webhook.js と同じ扱いにする。
  try {
    await assertPublicUrl(url, resolver);
  } catch (e) {
    logger.warn('OTS calendar blocked by SSRF guard', { calendar, error: e.message });
    appendAuditLog('audit_anchor_ots_blocked', { calendar, error: e.message });
    return { ...base, status: 'blocked', receiptB64: null, error: e.message };
  }

  try {
    const res = await httpPost(url, digest, {
      // OTS カレンダーは生の 32 バイトを body に取る。
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/vnd.opentimestamps.v1',
      },
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxContentLength: MAX_RECEIPT_BYTES,
      maxBodyLength: MAX_RECEIPT_BYTES,
    });
    const body = res && res.data;
    const buf = Buffer.isBuffer(body) ? body : (body ? Buffer.from(body) : Buffer.alloc(0));
    if (buf.length === 0) {
      return { ...base, status: 'failed', receiptB64: null, error: 'empty response' };
    }
    if (buf.length > MAX_RECEIPT_BYTES) {
      return { ...base, status: 'failed', receiptB64: null, error: 'receipt too large' };
    }
    return { ...base, status: 'submitted', receiptB64: buf.toString('base64'), error: null };
  } catch (e) {
    const msg = (e && e.message) || 'unknown error';
    logger.warn('OTS calendar submission failed', { calendar, error: msg });
    return { ...base, status: 'failed', receiptB64: null, error: msg };
  }
}

/**
 * Merkle root を全カレンダーへ提出する。
 *
 * 呼び出し元（anchor-scheduler）を絶対に落とさない: 全カレンダーが失敗しても throw せず、
 * status:'failed' のレコードを返すだけにする。監査アンカーの生成そのものはローカルで
 * 完結しており、外部提出の失敗でアンカーを失うのは本末転倒だからである。
 *
 * @param {string} rootHex 64 桁の hex（Merkle root）
 * @param {object} deps テスト注入（httpPost/resolver/now/calendars）
 * @returns {Promise<Array<object>>} カレンダーごとのレシートレコード（無効時は空配列）
 */
async function submitRoot(rootHex, deps = {}) {
  if (!isEnabled()) return [];
  if (typeof rootHex !== 'string' || !/^[0-9a-f]{64}$/i.test(rootHex)) {
    throw new Error('rootHex must be a 64-character hex string');
  }
  const list = deps.calendars || calendars();
  if (list.length === 0) return [];

  const digest = Buffer.from(rootHex, 'hex');
  const results = await Promise.all(list.map((c) => submitToCalendar(c, digest, deps)));
  return results.map((r) => ({ root: rootHex, ...r }));
}

module.exports = {
  submitRoot,
  submitToCalendar,
  isEnabled,
  calendars,
  digestUrl,
  DEFAULT_CALENDARS,
  MAX_RECEIPT_BYTES,
};
