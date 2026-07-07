// Webhook通知API（注文成立・支払い完了等のイベントで外部サービスへ通知）
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { appendAuditLog } = require('../utils/audit-log');
const { assertPublicUrl } = require('../utils/ssrf-guard');
const { logger } = require('../utils/logger');
const { authenticateJWT, checkRole } = require('./middleware/security');
const Joi = require('joi');

// Webhook送信先設定（環境変数またはDBで管理も可）
const WEBHOOK_URLS = (process.env.GENERIC_WEBHOOK || '').split(',').filter(Boolean);

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
    try {
      await axios.post(url, body);
      logger.info('Webhook送信成功', { url, event });
      appendAuditLog('webhook_sent', { url, event });
      success = true;
    } catch (e) {
      logger.warn('Webhook送信失敗', { url, event, error: e.message });
      appendAuditLog('webhook_failed', { url, event, error: e.message });
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

module.exports = { router, sendWebhook, notifyOrderCreated, notifyPaymentCompleted };
