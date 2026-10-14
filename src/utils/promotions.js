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
// 小数値は先に floor してから検証する — `>0` を先に見ると 0.5 のような値が
// floor で 0 になり、「0 日の featured を販売」「0 sat インボイス」になる。
function promotionConfig() {
  const days = Math.floor(Number(process.env.FEATURED_LISTING_DAYS));
  const priceSats = Math.floor(Number(process.env.FEATURED_LISTING_PRICE_SATS));
  return {
    days: Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS,
    priceSats: Number.isFinite(priceSats) && priceSats > 0 ? priceSats : DEFAULT_PRICE_SATS,
  };
}

function isFeatured(gpu, now = Date.now()) {
  if (!gpu || !gpu.featuredUntil) return false;
  const t = new Date(gpu.featuredUntil).getTime();
  return Number.isFinite(t) && t > now;
}

// 同一 GPU の未消化プロモーション支払い（冪等再利用用）。
// 期限切れ invoice を再利用しないのは invoice-poller が failed 化するまでの
// 間に stale invoice を返し続けるのを防ぐため。再利用されなかった stale
// pending は failStalePromotions で陽に失格化する（settle しても paid にならない
// ようにし、二重課金を防ぐ）。
function findPendingPromotion(gpuId) {
  const PaymentRepository = require('../db/json/PaymentRepository');
  const nowMs = Date.now();
  return (PaymentRepository.getAll() || []).find((p) =>
    p && p.purpose === PROMOTION_PURPOSE && p.gpuId === gpuId &&
    p.status === 'pending' &&
    (!p.invoiceExpiresAt || new Date(p.invoiceExpiresAt).getTime() > nowMs)
  ) || null;
}

// 同じ GPU への再購入時、生存不能な pending プロモーション支払いを failed 化。
// invoice-poller は expiry チェックより先に settle を判定するため、expired でも
// pending のままのインボイスは後から settle して paid+featured 化しうる —
// 新インボイスを出す前に旧 pending を終端へ進め、二重課金の余地をなくす。
function failStalePromotions(gpuId) {
  const PaymentRepository = require('../db/json/PaymentRepository');
  const nowMs = Date.now();
  let failed = 0;
  for (const p of PaymentRepository.getAll() || []) {
    if (p && p.purpose === PROMOTION_PURPOSE && p.gpuId === gpuId &&
        p.status === 'pending' &&
        p.invoiceExpiresAt && new Date(p.invoiceExpiresAt).getTime() <= nowMs) {
      const r = PaymentRepository.updateIf(p.id, (x) => x.status === 'pending', {
        status: 'failed',
        failedAt: new Date().toISOString(),
        failReason: 'replaced',
      });
      if (r && r.ok) failed++;
    }
  }
  return failed;
}

// 支払いが 'paid' へ遷移した際の副作用。featured_listing 目的の支払いなら
// GPU の featuredUntil を延長し、支払いに featuredActivatedAt を記録する。
// マーカーにより呼び出しは冪等（paid 確定後に再試行しても二重延長しない）—
// paid だが未適用のレコードは reconcilePaidPromotions が回収する。
// 延長規則は max(paidAt, 現在の featuredUntil) + days — 残期間を捨てず加算し、
// 適用が遅れても購入した期間を支払い時刻起点で満額与える。
function onPaymentPaid(payment, now = Date.now()) {
  if (!payment || payment.purpose !== PROMOTION_PURPOSE || !payment.gpuId) return null;
  const PaymentRepository = require('../db/json/PaymentRepository');
  const GpuRepository = require('../db/json/GpuRepository');
  const stored = PaymentRepository.getById(payment.id);
  if (!stored || stored.status !== 'paid' || stored.featuredActivatedAt) return null;
  const { days } = promotionConfig();
  const gpu = GpuRepository.getById(stored.gpuId);
  if (!gpu) {
    logger.warn(`promotion: paid payment ${stored.id} references missing gpu ${stored.gpuId}`);
    return null;
  }
  const paidMs = stored.paidAt ? new Date(stored.paidAt).getTime() : now;
  const anchor = Number.isFinite(paidMs) ? paidMs : now;
  const current = new Date(gpu.featuredUntil || 0).getTime();
  const base = Number.isFinite(current) && current > anchor ? current : anchor;
  const featuredUntil = new Date(base + days * 86_400_000).toISOString();
  const result = GpuRepository.updateIf(gpu.id, () => true, { featuredUntil });
  if (!result || !result.ok) {
    logger.warn(`promotion: failed to set featuredUntil on gpu ${gpu.id} (payment ${stored.id})`);
    return null;
  }
  PaymentRepository.update(stored.id, { featuredActivatedAt: new Date().toISOString() });
  appendAuditLog('featured_listing_activated', {
    gpuId: gpu.id,
    paymentId: stored.id,
    amount: stored.amount,
    featuredUntil,
  }, stored.userId);
  logger.info(`promotion: gpu ${gpu.id} featured until ${featuredUntil} (payment ${stored.id})`);
  return result.row;
}

// paid だが未適用（featuredActivatedAt なし）のプロモーション支払いを再試行する
// 和解ループ。GPU 書込みの一時失敗で滞留した購入を回収する。新しいデーモンは
// 立てず、既存の巡回点（invoice-poller tick / promote 購入）から呼ぶ。
// 返り値は「まだ未適用の残数」— 0 なら滞留なし。
function reconcilePaidPromotions(allPayments) {
  const PaymentRepository = require('../db/json/PaymentRepository');
  const payments = allPayments || PaymentRepository.getAll() || [];
  let remaining = 0;
  for (const p of payments) {
    if (p && p.purpose === PROMOTION_PURPOSE && p.status === 'paid' && !p.featuredActivatedAt) {
      if (!onPaymentPaid(p)) remaining++;
    }
  }
  return remaining;
}

// DELETE ガード: 未消化・未適用の購入がある、または featured 期間が有効中の GPU を
// 削除すると支払い済みの価値（featuredUntil は GPU 行ごと消える）が失われる。
function hasOpenPromotion(gpu) {
  if (!gpu) return false;
  if (isFeatured(gpu)) return true;
  const PaymentRepository = require('../db/json/PaymentRepository');
  return (PaymentRepository.getAll() || []).some((p) =>
    p && p.purpose === PROMOTION_PURPOSE && p.gpuId === gpu.id &&
    (p.status === 'pending' || (p.status === 'paid' && !p.featuredActivatedAt))
  );
}

module.exports = {
  PROMOTION_PURPOSE,
  promotionConfig,
  isFeatured,
  findPendingPromotion,
  failStalePromotions,
  onPaymentPaid,
  reconcilePaidPromotions,
  hasOpenPromotion,
};
