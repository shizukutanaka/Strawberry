// src/api/routes/payment/index.js - 決済関連APIルート
const express = require('express');
const router = express.Router();
const { asyncHandler, APIError, ErrorTypes } = require('../../../utils/error-handler');
const { validateMiddleware, schemas } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');
const { config } = require('../../../utils/config');

// コアサービスは共有のガード付きシングルトンから取得（未導入時は null）
const { lightning, p2pNetwork, requireService } = require('../../../core/services');
// ファイルベースJSONストレージリポジトリ
const PaymentRepository = require('../../../db/json/PaymentRepository');
const OrderRepository = require('../../../db/json/OrderRepository');
// 価格計算（時間単価解決・5分単価・JPY換算）の共通ユーティリティ
const { fetchRateInfo, computeOrderPricing } = require('../../../utils/order-pricing');

// インボイス作成 (認証必須)
router.post('/invoice',
  authenticateJWT,
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

// インボイス支払い (認証必須)
router.post('/pay', 
  authenticateJWT,
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
          error: error.message,
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
router.post('/order/:id', 
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    const { paymentMethod, amount } = req.body;
    logger.info(`Processing payment for order: ${orderId} (method: ${paymentMethod || 'lightning'})`);

    // 注文情報から金額自動取得（存在しない注文への 0 sats 請求書発行を防ぐ）
    const order = OrderRepository.getById(orderId);
    if (!order) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    }
    const rateInfo = await fetchRateInfo();
    const { pricePerHour, pricePer5Min, durationMinutes, totalPrice, totalPriceJPY } =
      computeOrderPricing(order, rateInfo);
    // Lightning以外も選択可能
    if (paymentMethod && paymentMethod !== 'lightning') {
      // 現金/銀行振込など
      const paymentRecord = PaymentRepository.create({
        orderId,
        userId: req.user.id,
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
      userId: req.user.id,
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
  })
);


// 支払いステータス確認（クライアントポーリング用）
router.get('/:id/status',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const payment = PaymentRepository.getById(req.params.id);
    if (!payment) throw new APIError(ErrorTypes.NOT_FOUND, 'Payment not found', 404);
    if (payment.userId !== req.user.id && req.user.role !== 'admin') {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Access denied', 403);
    }
    res.json({
      id: payment.id,
      orderId: payment.orderId,
      status: payment.status,
      amount: payment.amount,
      method: payment.method,
      paidAt: payment.paidAt || null,
      invoiceExpiresAt: payment.invoiceExpiresAt || null
    });
  })
);

// ライトニングノード情報取得
router.get('/node-info',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    if (!requireService(lightning, res)) return;
    logger.info('Fetching Lightning node info');

    // ノード情報を取得
    const nodeInfo = await lightning.getNodeInfo();
    
    // 機密情報をマスク
    if (nodeInfo.uris) {
      nodeInfo.uris = nodeInfo.uris.map(uri => {
        const parts = uri.split('@');
        if (parts.length > 1) {
          return `${parts[0].substring(0, 10)}...@${parts[1]}`;
        }
        return uri;
      });
    }
    
    res.json(nodeInfo);
  })
);

// チャネル一覧取得
router.get('/channels',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    if (!requireService(lightning, res)) return;
    logger.info('Fetching Lightning channels');

    // チャネル一覧を取得
    const channels = await lightning.listChannels();
    
    // 機密情報をマスク
    const sanitizedChannels = channels.map(channel => ({
      id: channel.channelId,
      active: channel.active,
      remote_pubkey: `${channel.remotePubkey.substring(0, 10)}...`,
      capacity: channel.capacity,
      local_balance: channel.localBalance,
      remote_balance: channel.remoteBalance,
      total_satoshis_sent: channel.totalSatoshisSent,
      total_satoshis_received: channel.totalSatoshisReceived,
      num_updates: channel.numUpdates
    }));
    
    res.json({
      total: sanitizedChannels.length,
      channels: sanitizedChannels
    });
  })
);

// 支払い履歴取得
router.get('/history', 
  authenticateJWT,
  asyncHandler(async (req, res) => {
    logger.info('Fetching payment history');
    
    // PaymentRepositoryから取得
    const history = PaymentRepository.getByUserId(req.user.id);
    // 必要な情報のみマスク・整形
    const sanitizedPayments = history.map(payment => ({
      id: payment.id,
      orderId: payment.orderId,
      amount: payment.amount,
      status: payment.status,
      paymentHash: payment.paymentHash,
      paidAt: payment.paidAt
    }));
    res.json({
      total: sanitizedPayments.length,
      payments: sanitizedPayments
    });
  })
);

// オンチェーンBTC決済（運営手数料控除）。
// 旧 routes/payment.js がディレクトリ解決を遮蔽（payment.js が payment/index.js より
// 優先）し、本ファイルの Lightning 決済API全体が未マウントになっていたため、
// /btc 配下のサブルートとして取り込んだ。グローバルJWTゲートの保護下にある。
router.use('/btc', require('./btc-onchain'));

// 管理者による手動支払い承認API
router.post('/manual/approve/:id',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const paymentId = req.params.id;
    const payment = PaymentRepository.getById(paymentId);
    if (!payment) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Payment not found', 404);
    }
    if (payment.method === 'lightning') {
      throw new APIError(ErrorTypes.VALIDATION, 'Lightning payments cannot be manually approved', 400);
    }
    if (payment.status === 'paid') {
      throw new APIError(ErrorTypes.VALIDATION, 'Payment already marked as paid', 400);
    }
    const updated = PaymentRepository.update(paymentId, {
      ...payment,
      status: 'paid',
      paidAt: new Date().toISOString()
    });
    res.json({
      message: 'Manual payment approved',
      paymentId,
      status: updated.status,
      paidAt: updated.paidAt
    });
  })
);

module.exports = router;
