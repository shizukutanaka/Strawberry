// src/utils/order-expiry.js - 未決済/未開始注文の自動失効
// pending: 決済タイムアウト（既定 30 分）
// matched: マッチ後に renter/provider がジョブを開始しない場合のタイムアウト（既定 60 分）
// disputed: 管理者が裁定しない場合の自動解決（既定 7 日 → 返金）
// タイムアウトは env 変数で上書き可能。呼出し毎に解決してテスト・運用での動的変更を許容。
const OrderRepository = require('../db/json/OrderRepository');
const { logger } = require('./logger');

const DEFAULT_TIMEOUT_MINUTES = 30;
const DEFAULT_MATCHED_TIMEOUT_MINUTES = 60;
const DEFAULT_DISPUTE_TIMEOUT_DAYS = 7;
// スケジュール済み pending 注文の絶対 TTL（scheduledStartAt にかかわらず）
const DEFAULT_SCHEDULED_PENDING_MAX_DAYS = 90;

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
    // 事前予約（scheduledStartAt が未来）はタイムアウト失効させない。
    // ただし作成から DEFAULT_SCHEDULED_PENDING_MAX_DAYS 日以上経過した場合は
    // scheduledStartAt にかかわらず失効させて在庫ブロッキング攻撃を防ぐ。
    if (order.scheduledStartAt) {
      const scheduledMs = Date.parse(order.scheduledStartAt);
      const maxAgeMs = DEFAULT_SCHEDULED_PENDING_MAX_DAYS * 24 * 60 * 60 * 1000;
      const isFutureSchedule = Number.isFinite(scheduledMs) && scheduledMs > now;
      const isAbsolutelyStale = createdMs < now - maxAgeMs;
      if (isFutureSchedule && !isAbsolutelyStale) continue;
    }
    // 原子的に pending→cancelled へ遷移する。スナップショット取得から書込みまでの間に
    // 別の sweep（同時 list/create 要求から呼ばれる）や /match が状態を変えている可能性が
    // あるため、書込み時点でも pending である場合のみ確定する。これが無いと:
    //   - 2 つの sweep が同じ注文を二重キャンセルし借り手へ通知が二重に飛ぶ
    //   - sweep が直前に確定した pending→matched を無条件 update で踏み潰す
    const result = OrderRepository.updateIf(order.id, (o) => o.status === 'pending', {
      status: 'cancelled',
      cancelReason: 'payment_timeout',
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (!result.ok) continue; // 既に他経路で確定済み（冪等）
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
    // 原子的に matched→cancelled。並行 sweep / /start による状態変化を踏み潰さない。
    const result = OrderRepository.updateIf(order.id, (o) => o.status === 'matched', {
      status: 'cancelled',
      cancelReason: 'match_timeout',
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (!result.ok) continue; // 既に他経路で確定済み（冪等）
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

/**
 * 管理者が長期間放置した係争注文を自動解決する（既定 7 日 → 返金）。
 * 資産凍結リスクを限定し、プロバイダが応答しない場合の借り手保護にもなる。
 * AUTO_DISPUTE_DECISION env で 'uphold'（提供者支持）に変更可（既定 'refund'）。
 * @returns {number} 自動解決した件数
 */
function expireStaleDisputedOrders() {
  const rawDays = process.env.ORDER_DISPUTE_TIMEOUT_DAYS;
  const days = (rawDays !== undefined && rawDays !== '' && Number.isFinite(Number(rawDays)) && Number(rawDays) >= 0)
    ? Number(rawDays) : DEFAULT_DISPUTE_TIMEOUT_DAYS;
  const timeoutMs = days * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - timeoutMs;
  const decision = (process.env.AUTO_DISPUTE_DECISION === 'uphold') ? 'uphold' : 'refund';
  let resolved = 0;

  for (const order of OrderRepository.getAll()) {
    if (order.status !== 'disputed') continue;
    const raisedMs = Date.parse(order.dispute && order.dispute.raisedAt || order.updatedAt || order.createdAt);
    if (!Number.isFinite(raisedMs) || raisedMs > cutoff) continue;

    const resolution = {
      decision,
      note: `Auto-resolved after ${days} day(s) without admin action`,
      resolvedAt: new Date().toISOString(),
      resolvedBy: 'system',
    };

    // 原子的に disputed→(cancelled|completed) へ遷移する。書込み時点でも disputed の
    // 場合のみ確定し、並行 sweep や管理者の手動裁定との二重解決・エスクロー二重返金・
    // 二重通知を防ぐ。
    const updates = decision === 'refund'
      ? {
          status: 'cancelled',
          cancelReason: 'dispute_auto_resolved_refund',
          cancelledAt: resolution.resolvedAt,
          updatedAt: resolution.resolvedAt,
          dispute: { ...(order.dispute || {}), resolution },
        }
      : {
          status: 'completed',
          stoppedAt: resolution.resolvedAt,
          updatedAt: resolution.resolvedAt,
          dispute: { ...(order.dispute || {}), resolution },
        };
    const result = OrderRepository.updateIf(order.id, (o) => o.status === 'disputed', updates);
    if (!result.ok) continue; // 既に他経路で解決済み（冪等）

    // エスクロー精算（状態確定後にのみ実行。失敗してもログのみ）
    try {
      const EscrowRepository = require('../db/json/EscrowRepository');
      const escrows = EscrowRepository.getAll().filter(e => e.orderId === order.id && e.state === 'HELD');
      for (const esc of escrows) {
        EscrowRepository.update(esc.id, { state: 'SETTLED', settledAt: resolution.resolvedAt });
      }
    } catch (e) {
      logger.warn(`Auto-dispute escrow settle failed (order=${order.id}, decision=${decision}): ${e.message}`);
    }
    resolved++;
    logger.info(`Dispute auto-resolved (${decision}) after ${days}d: order=${order.id}`);
    try {
      const { notifyUser } = require('./user-notify');
      const msg = `【Strawberry】係争が自動裁定（${decision === 'refund' ? '返金' : '提供者支持'}）されました\n注文: #${order.id}`;
      if (order.userId)     notifyUser(order.userId,     'dispute_auto_resolved', msg, {});
      if (order.providerId) notifyUser(order.providerId, 'dispute_auto_resolved', msg, {});
    } catch (_) { /* 通知失敗は失効処理を妨げない */ }
  }
  return resolved;
}

const DEFAULT_ACTIVE_TIMEOUT_HOURS = 48;

/**
 * active 状態のまま一定時間経過した注文を cancelled に遷移させる。
 * 悪意ある借り手が /stop を呼ばずに GPU を人質に取ることを防ぐ。
 * GPU の実際の解放（vgpuManager.releaseGPU）は呼び出し側が担当する。
 * @returns {{ id: string, gpuId: string }[]} タイムアウトした注文の配列
 */
function expireStaleActiveOrders() {
  const raw = process.env.ORDER_ACTIVE_TIMEOUT_HOURS;
  const n = raw !== undefined && raw !== '' ? Number(raw) : DEFAULT_ACTIVE_TIMEOUT_HOURS;
  const timeoutMs = (Number.isFinite(n) && n > 0 ? n : DEFAULT_ACTIVE_TIMEOUT_HOURS) * 60 * 60 * 1000;
  const cutoff = Date.now() - timeoutMs;
  const expired = [];
  for (const order of OrderRepository.getAll()) {
    if (order.status !== 'active') continue;
    const startMs = Date.parse(order.startedAt || order.updatedAt || order.createdAt);
    if (!Number.isFinite(startMs) || startMs > cutoff) continue;
    const now = new Date().toISOString();
    const result = OrderRepository.updateIf(order.id, (o) => o.status === 'active', {
      status: 'cancelled',
      cancelReason: 'active_timeout',
      cancelledAt: now,
      updatedAt: now,
    });
    if (!result.ok) continue;
    expired.push({ id: order.id, gpuId: order.gpuId });
    logger.info(`Order auto-expired (active timeout): ${order.id}`);
    try {
      const { notifyUser } = require('./user-notify');
      const msg = `【Strawberry】GPU 利用時間が上限を超えたため注文が自動キャンセルされました\n注文: #${order.id}`;
      if (order.userId)     notifyUser(order.userId,     'order_active_timeout', msg, {});
      if (order.providerId) notifyUser(order.providerId, 'order_active_timeout', msg, {});
    } catch (_) {}
  }
  return expired;
}

module.exports = { expireStaleOrders, expireStaleMatchedOrders, expireStaleDisputedOrders, expireStaleActiveOrders, resolveTimeoutMinutes };
