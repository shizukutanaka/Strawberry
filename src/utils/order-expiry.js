// src/utils/order-expiry.js - 未決済 pending 注文の自動失効
// pending のまま放置された注文は GPU を恒久的にブロックしない（二重予約チェックと対）。
// タイムアウトは ORDER_PENDING_TIMEOUT_MINUTES（既定 30 分）。呼出し毎に env を解決し、
// テスト・運用での動的変更を可能にする。
const OrderRepository = require('../db/json/OrderRepository');
const { logger } = require('./logger');

const DEFAULT_TIMEOUT_MINUTES = 30;

function resolveTimeoutMinutes() {
  const raw = process.env.ORDER_PENDING_TIMEOUT_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMEOUT_MINUTES;
}

/**
 * 期限切れの pending 注文を cancelled に遷移させる（pending→cancelled は正規遷移）。
 * @returns {number} 失効させた件数
 */
function expireStaleOrders() {
  const timeoutMs = resolveTimeoutMinutes() * 60 * 1000;
  const cutoff = Date.now() - timeoutMs;
  let expired = 0;
  for (const order of OrderRepository.getAll()) {
    if (order.status !== 'pending') continue;
    const createdMs = Date.parse(order.createdAt);
    if (!Number.isFinite(createdMs) || createdMs > cutoff) continue;
    OrderRepository.update(order.id, {
      status: 'cancelled',
      cancelReason: 'payment_timeout',
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expired++;
    logger.info(`Order auto-expired (payment timeout): ${order.id}`);
  }
  return expired;
}

module.exports = { expireStaleOrders, resolveTimeoutMinutes };
