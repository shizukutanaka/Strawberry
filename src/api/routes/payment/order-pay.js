// src/api/routes/payment/order-pay.js - 注文支払いエンドポイント
// （注文に紐付く Lightning インボイス発行 — 価格計算・二重発行抑止を含む）。
const express = require('express');
const router = express.Router();

const { asyncHandler, APIError, ErrorTypes } = require('../../../utils/error-handler');
const { logger } = require('../../../utils/logger');
const { authenticateJWT } = require('../../middleware/security');
const { config } = require('../../../utils/config');
const { lightning, requireService } = require('../../../core/services');
const PaymentRepository = require('../../../db/json/PaymentRepository');
const OrderRepository = require('../../../db/json/OrderRepository');
const { fetchRateInfo, computeOrderPricing } = require('../../../utils/order-pricing');
const { withLock } = require('../../../utils/async-lock');

router.post('/order/:id',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    // べき等性チェックと請求書発行をミューテックス内で行う。
    // ミューテックスなしだと並行リクエストが両方とも「未払いなし」と判断し
    // 同一注文に二重の Lightning インボイスが発行される。
    return withLock(`payment:${orderId}`, async () => {
    const { paymentMethod, amount } = req.body;
    logger.info(`Processing payment for order: ${orderId} (method: ${paymentMethod || 'lightning'})`);

    // 注文情報から金額自動取得（存在しない注文への 0 sats 請求書発行を防ぐ）
    const order = OrderRepository.getById(orderId);
    if (!order) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    }
    if (order.userId !== req.user.id && req.user.role !== 'admin') {
      throw new APIError(ErrorTypes.FORBIDDEN, 'You do not have permission to pay for this order', 403);
    }
    // 決済可能なステータスのみ許可。cancelled/completed/disputed 注文に対して
    // Lightning インボイスを発行すると、資金受取後に対応する注文が存在せず
    // 返金経路も存在しない（資金喪失）。
    const PAYABLE_STATUSES = new Set(['pending', 'matched']);
    if (!PAYABLE_STATUSES.has(order.status)) {
      throw new APIError(
        ErrorTypes.VALIDATION,
        `Cannot create payment for order in '${order.status}' state. Only pending or matched orders accept payment.`,
        400
      );
    }
    // べき等性: 同一注文に対する未払い(pending)かつ未失効の決済が既に存在すれば、
    // 新たに請求書/決済レコードを作らず既存を返す。クライアントのタイムアウト再送で
    // 二重請求書発行・二重支払いが起きるのを防ぐ（決済系で最も避けたい事故）。
    const nowMs = Date.now();
    // べき等性チェック: orderId で検索（userId を問わない）。管理者が同一注文に
    // 作成した既存の pending 請求書も再利用対象に含め、二重インボイスを防ぐ。
    const existingPending = (PaymentRepository.getByOrderId(orderId) || []).find(p =>
      p.status === 'pending' &&
      (!p.invoiceExpiresAt || new Date(p.invoiceExpiresAt).getTime() > nowMs)
    );
    if (existingPending) {
      logger.info(`Returning existing pending payment for order ${orderId} (idempotent)`, {
        userId: req.user.id, orderId, paymentId: existingPending.id,
      });
      return res.json({
        status: 'pending',
        idempotent: true,
        paymentId: existingPending.id,
        orderId,
        amountSats: existingPending.amount,
        paymentMethod: existingPending.method,
        paymentRequest: existingPending.paymentRequest || undefined,
        invoiceId: existingPending.paymentHash || undefined,
        expiresAt: existingPending.invoiceExpiresAt || undefined,
        message: 'A pending payment already exists for this order. Reusing it instead of creating a duplicate.',
      });
    }
    const rateInfo = await fetchRateInfo();
    const { pricePerHour, pricePer5Min, durationMinutes, totalPrice, totalPriceJPY } =
      computeOrderPricing(order, rateInfo);
    // Lightning以外も選択可能
    if (paymentMethod && paymentMethod !== 'lightning') {
      // 現金/銀行振込など
      const paymentRecord = PaymentRepository.create({
        orderId,
        userId: order.userId,
        providerId: null,
        amount: totalPrice,
        status: 'pending', // 管理者承認後に'paid'へ
        paymentHash: null,
        paidAt: null,
        method: paymentMethod
      });
      logger.info('Manual payment for order recorded (pending admin approval)', {
        userId: req.user.id,
        orderId,
        amount: totalPrice,
        paymentMethod,
        paymentId: paymentRecord.id
      });
      res.json({
        status: 'pending',
        amountPaid: totalPrice,
        amountPaidJPY: totalPriceJPY,
        paymentMethod,
        paymentId: paymentRecord.id,
        pricePerHour,
        pricePer5Min,
        durationMinutes,
        message: 'Manual payment request recorded. Please complete the transfer and contact admin for approval.'
      });
      return;
    }
    // Lightning払い（デフォルト）— サービス未導入時は 503
    // 重要: ダミーtxidで「支払い済み」を捏造してはならない（資金喪失の原因）。
    // 実インボイスを発行し、ステータスは pending（ウォレットでの支払い完了を待つ）。
    if (!requireService(lightning, res)) return;
    const invoice = await lightning.createInvoice({
      value: totalPrice,
      memo: `GPU rental order ${orderId}`,
      expiry: config.lightning.invoiceExpirySeconds
    });
    if (!invoice || !invoice.paymentRequest) {
      throw new APIError(ErrorTypes.LIGHTNING_ERROR, 'Failed to create Lightning invoice', 502);
    }
    const expiresAt = new Date(Date.now() + (config.lightning.invoiceExpirySeconds || 3600) * 1000).toISOString();
    const paymentRecord = PaymentRepository.create({
      orderId,
      userId: order.userId,
      providerId: null,
      amount: totalPrice,
      status: 'pending',
      paymentHash: invoice.id,
      paymentRequest: invoice.paymentRequest,
      paidAt: null,
      method: 'lightning',
      invoiceExpiresAt: expiresAt
    });
    res.status(201).json({
      status: 'pending',
      paymentRequest: invoice.paymentRequest,
      invoiceId: invoice.id,
      amountSats: totalPrice,
      amountPaidJPY: totalPriceJPY,
      paymentMethod: 'lightning',
      paymentId: paymentRecord.id,
      pricePerHour,
      pricePer5Min,
      durationMinutes,
      expiresAt,
      message: 'Lightning invoice created. Pay using your Lightning wallet.'
    });
    }); // end withLock
  })
);


// 支払いステータス確認（クライアントポーリング用）

module.exports = router;
