// Webhook通知API（注文成立・支払い完了等のイベントで外部サービスへ通知）
const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { appendAuditLog } = require('../utils/audit-log');
const { assertPublicUrl } = require('../utils/ssrf-guard');
const { logger } = require('../utils/logger');
const { authenticateJWT, checkRole } = require('./middleware/security');
const Joi = require('joi');

// Webhook送信先設定（環境変数またはDBで管理も可）
const WEBHOOK_URLS = (process.env.GENERIC_WEBHOOK || '').split(',').filter(Boolean);

// Stripe 流 HMAC 署名: 受信側が body の送信者正当性と鮮度（リプレイ耐性）を
// 検証できるよう `X-Strawberry-Signature: t=<unixsec>,v1=<hex>` を付与する。
// HMAC 対象は `t + '.' + rawBody` — timestamp を署名対象に含めることで
// 署名済みペイロードの切り貼りリプレイを防ぐ（受信側は ±5min 窓で検証する想定）。
// WEBHOOK_SIGNING_SECRET 未設定時は署名なし（後方互換 — 受信側は署名有無で検証有無を選べる）。
const WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || '';
function signWebhookBody(rawBody, nowSec = Math.floor(Date.now() / 1000)) {
  const t = String(nowSec);
  const v1 = crypto.createHmac('sha256', WEBHOOK_SIGNING_SECRET)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  return `t=${t},v1=${v1}`;
}

// Webhook送信関数
async function sendWebhook(event, payload) {
  const body = { event, payload, timestamp: new Date().toISOString() };
  let success = false;
  for (const url of WEBHOOK_URLS) {
    try {
      await assertPublicUrl(url);
    } catch (ssrfErr) {
      logger.warn('Webhook SSRF blocked', { url, event, error: ssrfErr.message });
      appendAuditLog('webhook_ssrf_blocked', { url, event, error: ssrfErr.message });
      continue;
    }
    const rawBody = JSON.stringify(body);
    const headers = WEBHOOK_SIGNING_SECRET
      ? { 'Content-Type': 'application/json', 'X-Strawberry-Signature': signWebhookBody(rawBody) }
      : { 'Content-Type': 'application/json' };
    if (!WEBHOOK_SIGNING_SECRET) {
      // 本番で署名無しは受信側が改ざん検知できないため、起動時ではなく送信時に1回警告
      logger.warn('WEBHOOK_SIGNING_SECRET unset; sending unsigned webhook');
    }
    // Stripe 流 at-least-once 配送: 一過性の 5xx/ネットワーク断で配送を落とさないため
    // 指数バックオフで再送する。リトライ毎に署名タイムスタンプを再発行して
    // 受信側の鮮度窓（±5min）から外れないようにする。
    // 4xx（恒久的拒否）は即座に諦める — 再送しても同じ結果で配送遅延になるだけ。
    const MAX_ATTEMPTS = Math.max(1, Number(process.env.WEBHOOK_MAX_ATTEMPTS) || 3);
    let attempts = 0;
    let lastErr = null;
    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      const signedHeaders = WEBHOOK_SIGNING_SECRET
        ? { ...headers, 'X-Strawberry-Signature': signWebhookBody(rawBody) }
        : headers;
      try {
        await axios.post(url, rawBody, { headers: signedHeaders });
        logger.info('Webhook送信成功', { url, event, attempts });
        appendAuditLog('webhook_sent', { url, event, signed: !!WEBHOOK_SIGNING_SECRET, attempts });
        success = true;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const status = e.response && e.response.status;
        const permanent = Number.isFinite(status) && status >= 400 && status < 500;
        if (permanent || attempts >= MAX_ATTEMPTS) break;
        const backoffMs = 1000 * Math.pow(2, attempts - 1); // 1s, 2s, 4s, ...
        logger.warn(`Webhook送信失敗（${attempts}/${MAX_ATTEMPTS}）`, { url, event, error: e.message, retryInMs: backoffMs });
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    if (lastErr) {
      logger.warn('Webhook送信失敗', { url, event, error: lastErr.message, attempts });
      appendAuditLog('webhook_failed', { url, event, error: lastErr.message, attempts });
    }
  }
  if (!success) throw new Error('全Webhook送信失敗');
}

// テスト用API（外部サービス連携確認用）— 管理者のみ
// 無認証だと任意のユーザーが GENERIC_WEBHOOK 宛に任意ペイロードを送信でき、
// SSRF・スパム・誤った監査ログが生じる。
router.post('/webhook/test', authenticateJWT, checkRole(['admin']), async (req, res) => {
  const schema = Joi.object({ event: Joi.string().required(), payload: Joi.object().required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  try {
    await sendWebhook(value.event, value.payload);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Webhook delivery failed' : e.message });
  }
});

// 注文成立・支払い完了等で利用する関数例
async function notifyOrderCreated(order) {
  await sendWebhook('order_created', { orderId: order.id, userId: order.userId, amount: order.totalPrice, time: new Date().toISOString() });
}
async function notifyPaymentCompleted(payment) {
  await sendWebhook('payment_completed', { paymentId: payment.id, orderId: payment.orderId, amount: payment.amount, userId: payment.userId, time: new Date().toISOString() });
}

module.exports = { router, sendWebhook, notifyOrderCreated, notifyPaymentCompleted, signWebhookBody };
