// src/core/invoice-settlement.js
// invoice-poller の per-invoice 遷移処理を stage 関数へ細分化したもの。
// pollOnce は走査・stat ゲート・スナップショット構築のみを担い、
// 「settled インボイスの fulfilment」と「期限切れインボイスの終端化」の
// 2 stage はここに集約する — 資金パスの各ガードを単体検証可能にするため。
const PaymentRepository = require('../db/json/PaymentRepository');
const OrderRepository = require('../db/json/OrderRepository');
const { logger } = require('../utils/logger');
const { appendAuditLog } = require('../utils/audit-log');
const promotions = require('../utils/promotions');

const INVOICE_EXPIRE_BUFFER_MS = 60_000; // 1 min grace after invoiceExpiresAt

function isInvoiceExpired(payment) {
  if (!payment.invoiceExpiresAt) return false;
  return Date.now() > new Date(payment.invoiceExpiresAt).getTime() + INVOICE_EXPIRE_BUFFER_MS;
}

// Stage: settled インボイスの fulfilment。
// ガード順: 不足支払い → 注文状態 → クロスメソッド重複 → paid 遷移 → 副作用 → 注文前進。
// ctx.orderById / ctx.paymentsByOrder は tick 冒頭スナップショットの Map —
// 最終遷移は updateIf CAS が原子再検証するため参照鮮度で安全性は変わらない。
function applySettledPayment(payment, invoiceStatus, ctx) {
  const { orderById, paymentsByOrder } = ctx || {};
  // Underpayment guard: a Lightning invoice can be reported settled while
  // the amount actually received is less than requested (partial/AMP
  // settlement, or a misbehaving payer). Marking such a payment 'paid'
  // would fulfil a full-price order for a fraction of its cost. Only the
  // amount the invoice actually received counts — verify it covers the
  // expected order amount before confirming.
  const paidSats = Number(
    invoiceStatus.amountPaid != null ? invoiceStatus.amountPaid : invoiceStatus.value
  );
  const expectedSats = Number(payment.amount);
  if (Number.isFinite(expectedSats) && expectedSats > 0 &&
      Number.isFinite(paidSats) && paidSats < expectedSats) {
    PaymentRepository.update(payment.id, {
      status: 'failed',
      failedAt: new Date().toISOString(),
      failReason: 'underpayment',
      amountPaid: paidSats
    });
    appendAuditLog('payment_underpaid', {
      paymentId: payment.id,
      orderId: payment.orderId,
      expected: expectedSats,
      paid: paidSats
    });
    logger.warn(`Invoice underpaid: paymentId=${payment.id} expected=${expectedSats} paid=${paidSats}; order not advanced`);
    return 'underpaid';
  }

  // 注文状態ゲート: キャンセル/完了済み注文への支払いを拒否。
  // Lightning インボイスは注文がキャンセルされた後も外部で決済できるため、
  // ポーラー側で注文状態を再確認して孤立 paid レコードの生成を防ぐ。
  if (payment.orderId) {
    const currentOrder = orderById.get(payment.orderId);
    const PAYABLE = new Set(['pending', 'matched']);
    if (!currentOrder || !PAYABLE.has(currentOrder.status)) {
      PaymentRepository.update(payment.id, {
        status: 'failed',
        failedAt: new Date().toISOString(),
        failReason: 'order_not_payable',
      });
      appendAuditLog('payment_order_not_payable', {
        paymentId: payment.id,
        orderId: payment.orderId,
        orderStatus: currentOrder ? currentOrder.status : 'not_found',
      });
      logger.warn(`Invoice settled but order not payable (orderId=${payment.orderId} status=${currentOrder ? currentOrder.status : 'missing'}); payment marked failed`);
      return 'order_not_payable';
    }
    // クロスメソッド二重支払いガード: 別の方式（BTC on-chain/手動）が
    // 既に settled している場合、Lightning の paid 記録を作成しない。
    const alreadyPaid = (paymentsByOrder.get(payment.orderId) || [])
      .filter(p => p.status === 'paid' && p.method !== 'lightning');
    if (alreadyPaid.length > 0) {
      PaymentRepository.update(payment.id, {
        status: 'failed',
        failedAt: new Date().toISOString(),
        failReason: 'already_paid_via_other_method',
      });
      appendAuditLog('payment_cross_method_duplicate_skipped', {
        paymentId: payment.id, orderId: payment.orderId,
      });
      logger.warn(`Invoice settled but order already paid via another method; paymentId=${payment.id}`);
      return 'duplicate_method';
    }
  }

  // Mark payment paid
  PaymentRepository.update(payment.id, {
    status: 'paid',
    paidAt: new Date().toISOString(),
    settledAt: invoiceStatus.settleDate || new Date().toISOString(),
    ...(Number.isFinite(paidSats) ? { amountPaid: paidSats } : {})
  });
  appendAuditLog('payment_confirmed', {
    paymentId: payment.id,
    orderId: payment.orderId,
    amount: payment.amount
  });
  logger.info(`Invoice settled: paymentId=${payment.id} orderId=${payment.orderId}`);
  // featured_listing 支払いの副作用（gpu.featuredUntil 延長）。
  // 決済の paid 記録は確定済み — 副作用失敗はポーラーを止めず警告に留める。
  try {
    promotions.onPaymentPaid(payment);
  } catch (e) {
    logger.warn(`promotion side-effect failed for payment ${payment.id}: ${e.message}`);
  }

  // Advance order to 'matched' if it is still 'pending'.
  // Use updateIf so a concurrent cancel/reject/expire wins definitively:
  // a plain getById+update race would let the poller resurrect a cancelled
  // order back to 'matched', corrupting cancelReason/cancelledAt metadata
  // and re-locking the GPU even though the user-cancel path already issued
  // an escrow refund.
  if (payment.orderId) {
    const writeResult = OrderRepository.updateIf(
      payment.orderId,
      (o) => o.status === 'pending',
      { status: 'matched', paidAt: new Date().toISOString() }
    );
    if (writeResult && writeResult.ok) {
      appendAuditLog('order_payment_confirmed', { orderId: payment.orderId });
      logger.info(`Order advanced to matched: orderId=${payment.orderId}`);
    } else {
      const curStatus = writeResult && writeResult.current && writeResult.current.status;
      logger.warn(`Invoice settled but order not pending (status=${curStatus}); skipping match. paymentId=${payment.id}`);
      appendAuditLog('order_payment_race_skipped', {
        orderId: payment.orderId, paymentId: payment.id, orderStatus: curStatus,
      });
    }
  }
  return 'paid';
}

// Stage: 期限切れインボイスの終端化。
// 他経路（手動承認/on-chain/別 tick の settled 処理）が pending を終端へ
// 進めた直後にこの書き込みが走ると paid→failed へ回帰させるため、
// pending 前提の CAS でのみ failed 化する。
function applyExpiredPayment(payment) {
  const writeResult = PaymentRepository.updateIf(
    payment.id,
    (p) => p.status === 'pending',
    {
      status: 'failed',
      failedAt: new Date().toISOString(),
      failReason: 'invoice_expired'
    }
  );
  if (writeResult && writeResult.ok) {
    appendAuditLog('payment_expired', { paymentId: payment.id, orderId: payment.orderId });
    logger.warn(`Invoice expired without payment: paymentId=${payment.id}`);
    return 'expired';
  }
  const curStatus = writeResult && writeResult.current && writeResult.current.status;
  logger.warn(`Invoice expired but payment already terminal (status=${curStatus}); skipping fail. paymentId=${payment.id}`);
  appendAuditLog('payment_expire_race_skipped', { paymentId: payment.id, status: curStatus });
  return 'already_terminal';
}

module.exports = { isInvoiceExpired, applySettledPayment, applyExpiredPayment };
