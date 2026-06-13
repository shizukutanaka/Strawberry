// src/utils/order-expiry.js - 未決済/未開始注文の自動失効
// pending: 決済タイムアウト（既定 30 分）
// matched: マッチ後に renter/provider がジョブを開始しない場合のタイムアウト（既定 60 分）
// タイムアウトは env 変数で上書き可能。呼出し毎に解決してテスト・運用での動的変更を許容。
const OrderRepository = require('../db/json/OrderRepository');
const { logger } = require('./logger');

const DEFAULT_TIMEOUT_MINUTES = 30;
const DEFAULT_MATCHED_TIMEOUT_MINUTES = 60;

function resolveTimeoutMinutes() {
  const raw = process.env.ORDER_PENDING_TIMEOUT_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMEOUT_MINUTES;
}

/**
 * 期限切れの pending 注文を cancelled に遷移させる（pending→cancelled は正規遷移）。
 * scheduledStartAt が未来の注文（事前予約）はタイムアウト対象外。
 * @returns {number} 失効させた件数
 */
function expireStaleOrders() {
  const timeoutMs = resolveTimeoutMinutes() * 60 * 1000;
  const cutoff = Date.now() - timeoutMs;
  const now = Date.now();
  let expired = 0;
  for (const order of OrderRepository.getAll()) {
    if (order.status !== 'pending') continue;
    const createdMs = Date.parse(order.createdAt);
    if (!Number.isFinite(createdMs) || createdMs > cutoff) continue;
    // 事前予約（scheduledStartAt が未来）はタイムアウト失効させない
    if (order.scheduledStartAt) {
      const scheduledMs = Date.parse(order.scheduledStartAt);
      if (Number.isFinite(scheduledMs) && scheduledMs > now) continue;
    }
    OrderRepository.update(order.id, {
      status: 'cancelled',
      cancelReason: 'payment_timeout',
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expired++;
    logger.info(`Order auto-expired (payment timeout): ${order.id}`);
    // 借り手へ失効通知（決済タイムアウトで自動キャンセルされたことを即時周知）
    try {
      const { notifyUser } = require('./user-notify');
      notifyUser(order.userId, 'order_expired',
        `【Strawberry】注文が決済タイムアウトにより自動キャンセルされました\n注文: #${order.id}`,
        { subject: `【Strawberry】注文 #${order.id} 自動キャンセル通知` });
    } catch (_) { /* 通知失敗は失効処理を妨げない */ }
  }
  return expired;
}

/**
 * マッチ済みだが一定時間内に開始されなかった注文を cancelled に遷移させる。
 * matchedAt（または updatedAt）から ORDER_MATCHED_TIMEOUT_MINUTES 以上経過した場合に失効。
 * @returns {number} 失効させた件数
 */
function expireStaleMatchedOrders() {
  const raw = process.env.ORDER_MATCHED_TIMEOUT_MINUTES;
  const n = raw !== undefined && raw !== '' ? Number(raw) : DEFAULT_MATCHED_TIMEOUT_MINUTES;
  const timeoutMs = (Number.isFinite(n) && n >= 0 ? n : DEFAULT_MATCHED_TIMEOUT_MINUTES) * 60 * 1000;
  const cutoff = Date.now() - timeoutMs;
  let expired = 0;
  for (const order of OrderRepository.getAll()) {
    if (order.status !== 'matched') continue;
    const matchedMs = Date.parse(order.matchedAt || order.updatedAt || order.createdAt);
    if (!Number.isFinite(matchedMs) || matchedMs > cutoff) continue;
    OrderRepository.update(order.id, {
      status: 'cancelled',
      cancelReason: 'match_timeout',
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expired++;
    logger.info(`Order auto-expired (match timeout): ${order.id}`);
    try {
      const { notifyUser } = require('./user-notify');
      notifyUser(order.userId, 'order_match_timeout',
        `【Strawberry】マッチした注文が開始されないため自動キャンセルされました\n注文: #${order.id}`,
        { subject: `【Strawberry】注文 #${order.id} 自動キャンセル通知` });
    } catch (_) { /* 通知失敗は失効処理を妨げない */ }
  }
  return expired;
}

module.exports = { expireStaleOrders, expireStaleMatchedOrders, resolveTimeoutMinutes };
