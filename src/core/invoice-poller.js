// src/core/invoice-poller.js
// Polls pending Lightning invoices and transitions payment/order state when settled.
// Design: single setInterval loop, re-entrant-safe (lock prevents overlapping runs).
const { logger } = require('../utils/logger');
const PaymentRepository = require('../db/json/PaymentRepository');
const OrderRepository = require('../db/json/OrderRepository');
const { appendAuditLog } = require('../utils/audit-log');

const POLL_INTERVAL_MS = 15_000; // check every 15 s
const INVOICE_EXPIRE_BUFFER_MS = 60_000; // 1 min grace after invoiceExpiresAt

let _timer = null;
let _running = false;
let _lightning = null; // set via start()

async function pollOnce() {
  if (!_lightning || _running) return;
  _running = true;
  try {
    const pending = PaymentRepository.getAll().filter(
      (p) => p.method === 'lightning' && p.status === 'pending' && p.paymentHash
    );
    if (pending.length === 0) return;

    for (const payment of pending) {
      try {
        const invoiceStatus = await _lightning.checkInvoice(payment.paymentHash);

        if (invoiceStatus && invoiceStatus.settled) {
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
            continue;
          }

          // 注文状態ゲート: キャンセル/完了済み注文への支払いを拒否。
          // Lightning インボイスは注文がキャンセルされた後も外部で決済できるため、
          // ポーラー側で注文状態を再確認して孤立 paid レコードの生成を防ぐ。
          if (payment.orderId) {
            const currentOrder = OrderRepository.getById(payment.orderId);
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
              continue;
            }
            // クロスメソッド二重支払いガード: 別の方式（BTC on-chain/手動）が
            // 既に settled している場合、Lightning の paid 記録を作成しない。
            const alreadyPaid = (PaymentRepository.getByOrderId(payment.orderId) || [])
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
              continue;
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
        } else if (_isExpired(payment)) {
          // Invoice expired without payment — mark failed
          PaymentRepository.update(payment.id, {
            status: 'failed',
            failedAt: new Date().toISOString(),
            failReason: 'invoice_expired'
          });
          appendAuditLog('payment_expired', { paymentId: payment.id, orderId: payment.orderId });
          logger.warn(`Invoice expired without payment: paymentId=${payment.id}`);
        }
      } catch (err) {
        // Per-invoice errors should not crash the whole poll cycle
        logger.warn(`invoice-poller: error checking paymentId=${payment.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`invoice-poller: unexpected error: ${err.message}`);
  } finally {
    _running = false;
  }
}

function _isExpired(payment) {
  if (!payment.invoiceExpiresAt) return false;
  return Date.now() > new Date(payment.invoiceExpiresAt).getTime() + INVOICE_EXPIRE_BUFFER_MS;
}

function start(lightningService) {
  if (_timer) return; // already running
  if (!lightningService) {
    logger.warn('invoice-poller: Lightning service unavailable — poller not started');
    return;
  }
  _lightning = lightningService;
  _timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  // unref so the timer does not prevent process exit
  if (_timer.unref) _timer.unref();
  logger.info(`invoice-poller: started (interval=${POLL_INTERVAL_MS}ms)`);
  // run immediately on start
  pollOnce();
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _lightning = null;
  _running = false;
}

module.exports = { start, stop, pollOnce };
