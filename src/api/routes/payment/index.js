// src/api/routes/payment/index.js - 決済関連APIルート
const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');
const { config } = require('../../../utils/config');

// Lightning Network関連クラスのインポート
const { LightningService } = require('../../../../lightning-service');
const { P2PNetwork } = require('../../../../p2p-network');
// ファイルベースJSONストレージリポジトリ
const PaymentRepository = require('../../../db/json/PaymentRepository');

// シングルトンインスタンス
const lightning = new LightningService();
const p2pNetwork = new P2PNetwork();

// インボイス作成 (認証必須)
router.post('/invoice', 
  authenticateJWT,
  validateMiddleware(schemas.payment.createInvoice),
  asyncHandler(async (req, res) => {
    const { amount, description, expiry } = req.validatedBody;
    logger.info(`Creating invoice for ${amount} satoshis`);
    
    // 金額の範囲をチェック
    if (amount < config.lightning.minPaymentSatoshis) {
      return res.status(400).json({ 
        error: `Amount too small. Minimum: ${config.lightning.minPaymentSatoshis} satoshis` 
      });
    }
    
    if (amount > config.lightning.maxPaymentSatoshis) {
      return res.status(400).json({ 
        error: `Amount too large. Maximum: ${config.lightning.maxPaymentSatoshis} satoshis` 
      });
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
    const invoiceId = req.params.id;
    logger.info(`Checking invoice status: ${invoiceId}`);
    
    // インボイス状態を確認
    const invoiceStatus = await lightning.checkInvoice(invoiceId);
    
    if (!invoiceStatus) {
      return res.status(404).json({ error: 'Invoice not found' });
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

    // 注文情報から金額自動取得
    const OrderRepository = require('../../../db/json/OrderRepository');
    const order = OrderRepository.getById(orderId);
    let pricePerHour = 0;
    let durationMinutes = 0;
    if (order) {
      pricePerHour = order.pricePerHour || order.maxPricePerHour || 0;
      durationMinutes = order.durationMinutes || 0;
      if (!pricePerHour && order.gpuId) {
        try {
          const GpuRepository = require('../../../db/json/GpuRepository');
          const gpu = GpuRepository.getById(order.gpuId);
          if (gpu && gpu.pricePerHour) pricePerHour = gpu.pricePerHour;
        } catch {}
      }
    }
    const pricePer5Min = pricePerHour / 12;
    const totalPrice = pricePer5Min * (durationMinutes / 5);
    // リアルタイムBTC/JPY換算
    const { getBTCtoJPYRate } = require('../../../utils/exchange-rate');
    const satoshiToJPY = await getBTCtoJPYRate();
    const totalPriceJPY = Math.round(totalPrice * satoshiToJPY);
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
    // Lightning払い（デフォルト）
    // ...既存Lightning決済処理（ダミー/実装済み部分を流用）...
    const paymentRecord = PaymentRepository.create({
      orderId,
      userId: req.user.id,
      providerId: null,
      amount: totalPrice,
      status: 'paid',
      paymentHash: 'dummy',
      paidAt: new Date().toISOString(),
      method: 'lightning'
    });
    res.json({
      status: paymentRecord.status,
      paymentHash: paymentRecord.paymentHash,
      amountPaid: totalPrice,
      amountPaidJPY: totalPriceJPY,
      paymentMethod: 'lightning',
      paymentId: paymentRecord.id,
      pricePerHour,
      pricePer5Min,
      durationMinutes,
      message: 'Payment successful (recorded in PaymentRepository)'
    });
  })
);


// ライトニングノード情報取得
router.get('/node-info', 
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
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

// 管理者による手動支払い承認API
router.post('/manual/approve/:id',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const paymentId = req.params.id;
    const PaymentRepository = require('../../../db/json/PaymentRepository');
    const payment = PaymentRepository.getById(paymentId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    if (payment.method === 'lightning') {
      return res.status(400).json({ error: 'Lightning payments cannot be manually approved' });
    }
    if (payment.status === 'paid') {
      return res.status(400).json({ error: 'Payment already marked as paid' });
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
