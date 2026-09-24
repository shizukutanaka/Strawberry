// src/api/routes/payment/admin.js - 管理者系決済エンドポイント
// （手動入金の審査・承認 — checkRole(['admin']) 配下）。
const express = require('express');
const router = express.Router();

const { asyncHandler, APIError, ErrorTypes } = require('../../../utils/error-handler');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');
const { lightning } = require('../../../core/services');
const PaymentRepository = require('../../../db/json/PaymentRepository');
const OrderRepository = require('../../../db/json/OrderRepository');
const UserRepository = require('../../../db/json/UserRepository');
const { withLock } = require('../../../utils/async-lock');

router.get('/admin/pending',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const all = PaymentRepository.getAll() || [];
    const pending = all.filter(p => p.status === 'pending' && p.method !== 'lightning');
    const sorted = [...pending].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const enriched = sorted.map(p => {
      const order = p.orderId ? OrderRepository.getById(p.orderId) : null;
      const renter = p.userId ? UserRepository.getById(p.userId) : null;
      return {
        id: p.id,
        orderId: p.orderId,
        amount: p.amount,
        method: p.method,
        createdAt: p.createdAt || null,
        orderStatus: order ? order.status : null,
        renterUsername: renter ? renter.username : null,
      };
    });
    res.json({ total: enriched.length, payments: enriched });
  })
);

// 管理者による手動支払い承認API

router.post('/manual/approve/:id',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const paymentId = req.params.id;
    // withLock prevents TOCTOU between the order-status guard and the updateIf CAS:
    // without it, two admins could both pass the order-status check (order still 'pending')
    // and then both call updateIf, with the second succeeding if the first hasn't committed yet.
    await withLock(`payment:${paymentId}`, async () => {
      const payment = PaymentRepository.getById(paymentId);
      if (!payment) {
        throw new APIError(ErrorTypes.NOT_FOUND, 'Payment not found', 404);
      }
      if (payment.method === 'lightning') {
        throw new APIError(ErrorTypes.VALIDATION, 'Lightning payments cannot be manually approved', 400);
      }
      // Guard: approving a payment on a cancelled/completed order creates an orphaned
      // paid record that can confuse reconciliation and future hasPaidPayment checks.
      // Only approve if the associated order is in a payable state.
      if (payment.orderId) {
        const order = OrderRepository.getById(payment.orderId);
        if (order && !['pending', 'matched'].includes(order.status)) {
          throw new APIError(
            ErrorTypes.VALIDATION,
            `Cannot approve payment: associated order is in '${order.status}' state (only pending/matched orders accept payment approval)`,
            409
          );
        }
      }
      // Atomic compare-and-swap: check status and write in one synchronous section to
      // prevent two concurrent admin approvals from both seeing status!=='paid' and
      // double-approving the same payment.
      const result = PaymentRepository.updateIf(
        paymentId,
        p => p.status !== 'paid' && p.method !== 'lightning',
        { status: 'paid', paidAt: new Date().toISOString() }
      );
      if (!result.ok) {
        const cur = result.current;
        if (cur && cur.status === 'paid') {
          throw new APIError(ErrorTypes.VALIDATION, 'Payment already marked as paid', 400);
        }
        throw new APIError(ErrorTypes.VALIDATION, 'Payment cannot be approved in its current state', 400);
      }
      const updated = result.row;
      res.json({
        message: 'Manual payment approved',
        paymentId,
        status: updated.status,
        paidAt: updated.paidAt
      });
    });
  })
);


module.exports = router;
