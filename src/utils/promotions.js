// src/utils/promotions.js
// 出品プロモーション（有料ブースト）— マーケットプレイスの追加収益面。
// プロバイダが featured_listing 支払いを行うと gpu.featuredUntil が延長され、
// GPU 一覧で上位表示される。支払いは既存の payments.json に purpose 付きで
// 記録されるため新しい永続化は不要（orderId を持たない非注文支払い）。
const { appendAuditLog } = require('./audit-log');
const { logger } = require('./logger');

// payments.json の purpose 値。featured 購入以外の非注文支払いとは区別する。
const PROMOTION_PURPOSE = 'featured_listing';

const DEFAULT_DAYS = 7;
const DEFAULT_PRICE_SATS = 1000;

// FEATURED_LISTING_DAYS / FEATURED_LISTING_PRICE_SATS で運用調整可能。
// 価格は一律（日数×単価のティアは持たない — 課金形態を1種に絞り検算を単純化）。
function promotionConfig() {
  const days = Number(process.env.FEATURED_LISTING_DAYS);
  const priceSats = Number(process.env.FEATURED_LISTING_PRICE_SATS);
  return {
    days: Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_DAYS,
    priceSats: Number.isFinite(priceSats) && priceSats > 0 ? Math.floor(priceSats) : DEFAULT_PRICE_SATS,
  };
}

function isFeatured(gpu, now = Date.now()) {
  if (!gpu || !gpu.featuredUntil) return false;
  const t = new Date(gpu.featuredUntil).getTime();
  return Number.isFinite(t) && t > now;
}

// 同一 GPU の未消化プロモーション支払い（冪等再利用用）。
// 期限切れ invoice を再利用しないのは invoice-poller が failed 化するまでの
// 間に stale invoice を返し続けるのを防ぐため。
function findPendingPromotion(gpuId) {
  const PaymentRepository = require('../db/json/PaymentRepository');
  const nowMs = Date.now();
  return (PaymentRepository.getAll() || []).find((p) =>
    p && p.purpose === PROMOTION_PURPOSE && p.gpuId === gpuId &&
    p.status === 'pending' &&
    (!p.invoiceExpiresAt || new Date(p.invoiceExpiresAt).getTime() > nowMs)
  ) || null;
}

// 支払いが 'paid' へ遷移した際の副作用。featured_listing 目的の支払いなら
// GPU の featuredUntil を延長する。paid 遷移は各経路で一度だけ起きる
// （LN: invoice-poller、手動: admin 承認 CAS）ため二重適用は起きない。
// 延長規則は max(now, 現在の featuredUntil) + days — 残期間を捨てず加算する。
function onPaymentPaid(payment, now = Date.now()) {
  if (!payment || payment.purpose !== PROMOTION_PURPOSE || !payment.gpuId) return null;
  const GpuRepository = require('../db/json/GpuRepository');
  const { days } = promotionConfig();
  const gpu = GpuRepository.getById(payment.gpuId);
  if (!gpu) {
    logger.warn(`promotion: paid payment ${payment.id} references missing gpu ${payment.gpuId}`);
    return null;
  }
  const current = new Date(gpu.featuredUntil || 0).getTime();
  const base = Number.isFinite(current) && current > now ? current : now;
  const featuredUntil = new Date(base + days * 86_400_000).toISOString();
  const result = GpuRepository.updateIf(gpu.id, () => true, { featuredUntil });
  if (!result || !result.ok) {
    logger.warn(`promotion: failed to set featuredUntil on gpu ${gpu.id} (payment ${payment.id})`);
    return null;
  }
  appendAuditLog('featured_listing_activated', {
    gpuId: gpu.id,
    paymentId: payment.id,
    amount: payment.amount,
    featuredUntil,
  }, payment.userId);
  logger.info(`promotion: gpu ${gpu.id} featured until ${featuredUntil} (payment ${payment.id})`);
  return result.row;
}

module.exports = { PROMOTION_PURPOSE, promotionConfig, isFeatured, findPendingPromotion, onPaymentPaid };
