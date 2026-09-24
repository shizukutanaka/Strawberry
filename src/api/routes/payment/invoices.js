// src/api/routes/payment/invoices.js - インボイス発行・支払い系エンドポイント
const express = require('express');
const router = express.Router();

const { asyncHandler, APIError, ErrorTypes } = require('../../../utils/error-handler');
const { validateMiddleware, schemas } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');
const { config } = require('../../../utils/config');
const { lightning, requireService } = require('../../../core/services');
const PaymentRepository = require('../../../db/json/PaymentRepository');

router.post('/invoice',
  authenticateJWT,
  checkRole(['admin']),
  validateMiddleware(schemas.payment.createInvoice),
  asyncHandler(async (req, res) => {
    if (!requireService(lightning, res)) return;
    const { amount, description, expiry } = req.validatedBody;
    logger.info(`Creating invoice for ${amount} satoshis`);

    // 金額の範囲をチェック
    if (amount < config.lightning.minPaymentSatoshis) {
      throw new APIError(ErrorTypes.VALIDATION, `Amount too small. Minimum: ${config.lightning.minPaymentSatoshis} satoshis`, 400);
    }
    
    if (amount > config.lightning.maxPaymentSatoshis) {
      throw new APIError(ErrorTypes.VALIDATION, `Amount too large. Maximum: ${config.lightning.maxPaymentSatoshis} satoshis`, 400);
    }
    
    // インボイスを作成
    const invoice = await lightning.createInvoice({
      value: amount,
      memo: description,
      expiry: expiry || config.lightning.invoiceExpirySeconds
    });
    
    // インボイス情報をログに記録
    logger.info(`Invoice created: ${invoice.paymentRequest.substring(0, 20)}...`, {
      amount,
      userId: req.user.id,
      invoiceId: invoice.id
    });
    
    res.status(201).json({
      message: 'Invoice created',
      paymentRequest: invoice.paymentRequest,
      id: invoice.id,
      amount,
      description,
      expiresAt: invoice.expiresAt
    });
  })
);

// インボイス支払い (管理者専用)
// 任意 BOLT11 invoice をプラットフォームの Lightning ノードから払い出すため、
// 一般ユーザーに開放すると攻撃者が自分宛の invoice を生成して送金させ、
// チャネル容量を吸い上げることが可能（資金喪失に直結）。
// 通常の注文支払いは /payments/order/:id を使うこと。

router.post('/pay',
  authenticateJWT,
  checkRole(['admin']),
  validateMiddleware(schemas.payment.pay),
  asyncHandler(async (req, res) => {
    const { paymentRequest, amount, maxFeePercent, paymentMethod } = req.validatedBody;
    logger.info('Processing payment');

    // Lightning or manual (現金/銀行振込) 支払い対応
    if (paymentMethod === 'lightning' || (!paymentMethod && paymentRequest)) {
      // Lightning Network 支払い
      if (!requireService(lightning, res)) return;
      try {
        const paymentResult = await lightning.payInvoice(paymentRequest, amount, maxFeePercent);
        logger.info(`Payment successful: ${paymentResult.paymentHash.substring(0, 10)}...`, {
          userId: req.user.id,
          amountPaid: paymentResult.valueSat,
          fee: paymentResult.feeSat
        });
        // PaymentRepositoryにも記録
        PaymentRepository.create({
          userId: req.user.id,
          amount: paymentResult.valueSat,
          status: 'paid',
          paymentHash: paymentResult.paymentHash,
          paidAt: new Date().toISOString(),
          method: 'lightning'
        });
        res.json({
          message: 'Payment successful',
          paymentHash: paymentResult.paymentHash,
          status: 'paid',
          fee: paymentResult.feeSat,
          amountPaid: paymentResult.valueSat,
          paymentMethod: 'lightning'
        });
      } catch (error) {
        logger.error(`Payment failed: ${error.message}`);
        res.status(400).json({
          message: 'Payment failed',
          status: 'failed',
          error: process.env.NODE_ENV === 'production' ? 'Lightning payment failed' : error.message,
          paymentMethod: 'lightning'
        });
      }
    } else {
      // Lightning以外の支払い（現金/銀行振込など）
      const paymentRecord = PaymentRepository.create({
        userId: req.user.id,
        amount,
        status: 'pending', // 管理者承認後に'paid'へ
        paymentHash: null,
        paidAt: null,
        method: paymentMethod || 'manual'
      });
      logger.info('Manual payment recorded (pending admin approval)', {
        userId: req.user.id,
        amount,
        paymentMethod: paymentMethod || 'manual',
        paymentId: paymentRecord.id
      });
      res.json({
        message: 'Manual payment request recorded. Please complete the transfer and contact admin for approval.',
        status: 'pending',
        amount,
        paymentMethod: paymentMethod || 'manual',
        paymentId: paymentRecord.id
      });
    }
  })
);

// インボイス状態確認

router.get('/invoice/:id',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    if (!requireService(lightning, res)) return;
    const invoiceId = req.params.id;
    logger.info(`Checking invoice status: ${invoiceId}`);

    // 所有権チェック: インボイス(paymentHash)に紐づく決済レコードの所有者、
    // または管理者のみ閲覧可。任意の invoiceId 推測で他人の金額・入金状況を
    // 覗けないようにする（情報漏洩防止）。
    if (req.user.role !== 'admin') {
      const records = PaymentRepository.getByPaymentHash(invoiceId);
      const owns = Array.isArray(records) && records.some(p => p.userId === req.user.id);
      if (!owns) {
        throw new APIError(ErrorTypes.FORBIDDEN, 'You do not have permission to view this invoice', 403);
      }
    }

    // インボイス状態を確認
    const invoiceStatus = await lightning.checkInvoice(invoiceId);
    
    if (!invoiceStatus) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Invoice not found', 404);
    }
    
    res.json({
      id: invoiceId,
      status: invoiceStatus.settled ? 'paid' : 'pending',
      settledAt: invoiceStatus.settleDate,
      amount: invoiceStatus.value,
      expiresAt: invoiceStatus.expiresAt
    });
  })
);

// オーダーに対する支払い処理 (認証必須)

module.exports = router;
