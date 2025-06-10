// src/api/routes/order/index.js - オーダー関連APIルート
const express = require('express');
const router = express.Router();

// --- 利用時間セッション管理クラス ---
const usageSessions = new Map(); // orderId -> OrderUsageSession
class OrderUsageSession {
  constructor(orderId, lenderId, renterId) {
    this.orderId = orderId;
    this.lenderId = lenderId;
    this.renterId = renterId;
    this.lenderActive = false;
    this.renterActive = false;
    this.usageStart = null;
    this.accumulatedSeconds = 0;
    this.lastLenderHeartbeat = null;
    this.lastRenterHeartbeat = null;
    this.HEARTBEAT_TIMEOUT = 20 * 1000; // 20秒
  }
  onHeartbeat(userId, role) {
    const now = Date.now();
    if (role === 'lender') {
      this.lenderActive = true;
      this.lastLenderHeartbeat = now;
    } else if (role === 'renter') {
      this.renterActive = true;
      this.lastRenterHeartbeat = now;
    }
    this.updateTimer();
  }
  updateTimer() {
    const now = Date.now();
    if (this.lenderActive && this.renterActive) {
      if (!this.usageStart) this.usageStart = now;
    } else {
      if (this.usageStart) {
        this.accumulatedSeconds += Math.floor((now - this.usageStart) / 1000);
        this.usageStart = null;
      }
    }
  }
  checkTimeouts() {
    const now = Date.now();
    if (this.lastLenderHeartbeat && now - this.lastLenderHeartbeat > this.HEARTBEAT_TIMEOUT) {
      this.lenderActive = false;
      this.updateTimer();
    }
    if (this.lastRenterHeartbeat && now - this.lastRenterHeartbeat > this.HEARTBEAT_TIMEOUT) {
      this.renterActive = false;
      this.updateTimer();
    }
  }
  getUsageSeconds() {
    let total = this.accumulatedSeconds;
    if (this.usageStart) {
      total += Math.floor((Date.now() - this.usageStart) / 1000);
    }
    return total;
  }
}

// 全セッションのタイムアウト監視（30秒ごと）
setInterval(() => {
  for (const session of usageSessions.values()) {
    session.checkTimeouts();
  }
}, 30000);

const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');

// 必要なクラスのインポート
const { P2PNetwork } = require('../../../../p2p-network');
const { VirtualGPUManager } = require('../../../../virtual-gpu-manager');
const { v4: uuidv4 } = require('uuid');
// ファイルベースJSONストレージリポジトリ
const OrderRepository = require('../../../db/json/OrderRepository');

// シングルトンインスタンス
const p2pNetwork = new P2PNetwork();
const vgpuManager = new VirtualGPUManager();

const { apiKeyAuth } = require('../../middleware/security');
const { sanitizeObject } = require('../../../utils/sanitize');

// オーダー一覧取得 (認証必須)
const { cacheMiddleware } = require('../../middleware/cache');

router.get('/', 
  cacheMiddleware(),
  apiKeyAuth,
  authenticateJWT,
  asyncHandler(async (req, res, next) => {
    try {
      logger.info('Fetching orders');
      let orders;
      if (req.user.role === 'admin') {
        orders = OrderRepository.getAll();
      } else if (req.user.role === 'provider') {
        orders = OrderRepository.getAll().filter(o => o.providerId === req.user.id);
      } else {
        orders = OrderRepository.getByUserId(req.user.id);
      }
      const status = req.query.status;
      if (status) {
        orders = orders.filter(order => order.status === status);
      }
      const sortBy = req.query.sortBy || 'createdAt';
      const sortDir = req.query.sortDir === 'asc' ? 1 : -1;
      orders.sort((a, b) => {
        if (a[sortBy] < b[sortBy]) return -1 * sortDir;
        if (a[sortBy] > b[sortBy]) return 1 * sortDir;
        return 0;
      });
      // リアルタイムBTC/JPY換算
      const { getBTCtoJPYRate } = require('../../../utils/exchange-rate');
      const { rate: satoshiToJPY, timestamp: exchangeRateTimestamp } = await getBTCtoJPYRate(false, true);
      const ordersWithPricing = orders.map(order => {
        let pricePerHour = order.pricePerHour || order.maxPricePerHour || 0;
        if (!pricePerHour && order.gpuId) {
          try {
            const GpuRepository = require('../../../db/json/GpuRepository');
            const gpu = GpuRepository.getById(order.gpuId);
            if (gpu && gpu.pricePerHour) pricePerHour = gpu.pricePerHour;
          } catch {}
        }
        const durationMinutes = order.durationMinutes || 0;
        const pricePer5Min = pricePerHour / 12;
        const totalPrice = pricePer5Min * (durationMinutes / 5);
        // 冗長化為替APIで換算（キャッシュ活用）
        const totalPriceJPY = Math.round(totalPrice * satoshiToJPY);
        return {
          ...order,
          pricePerHour,
          pricePer5Min,
          totalPrice,
          totalPriceJPY,
          exchangeRateTimestamp
        };
      });
      res.json({
        message: 'Fetched orders',
        total: ordersWithPricing.length,
        orders: ordersWithPricing,
        exchangeRateTimestamp
      });
    } catch (error) {
      next(error);
    }
  })
);

// --- ハートビート受付API ---
// POST /api/orders/:id/heartbeat { role: 'lender'|'renter' }
router.post('/:id/heartbeat',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    const { role } = req.body;
    const { APIError, ErrorTypes } = require('../../../utils/error-handler');
    if (!['lender', 'renter'].includes(role)) {
      throw new APIError(ErrorTypes.VALIDATION, 'role must be lender or renter', 400);
    }
    // オーダー取得
    const order = OrderRepository.getById(orderId);
    if (!order) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    }
    // 権限チェック
    if ((role === 'lender' && req.user.id !== order.providerId) ||
        (role === 'renter' && req.user.id !== order.userId)) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'No permission for this order as this role', 403);
    }
    // セッション取得または作成
    let session = usageSessions.get(orderId);
    if (!session) {
      session = new OrderUsageSession(orderId, order.providerId, order.userId);
      usageSessions.set(orderId, session);
    }
    session.onHeartbeat(req.user.id, role);
    res.json({ usageSeconds: session.getUsageSeconds() });
  })
);

// オーダー詳細取得 (認証必須)
router.get('/:id',
  apiKeyAuth,
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  allowOwnerOrAdmin((req) => OrderRepository.getById(req.params.id)),
  asyncHandler(async (req, res, next) => {
    try {
      logger.info(`Fetching order detail: ${req.params.id}`);
      const order = req.resource;
      let pricePerHour = order.pricePerHour || order.maxPricePerHour || 0;
      if (!pricePerHour && order.gpuId) {
        try {
          const GpuRepository = require('../../../db/json/GpuRepository');
          const gpu = GpuRepository.getById(order.gpuId);
          if (gpu && gpu.pricePerHour) pricePerHour = gpu.pricePerHour;
        } catch {}
      }
      const durationMinutes = order.durationMinutes || 0;
      const pricePer5Min = pricePerHour / 12;
      const totalPrice = pricePer5Min * (durationMinutes / 5);
      // 冗長化為替APIで換算（キャッシュ活用）
      const { getBTCtoJPYRate } = require('../../../utils/exchange-rate');
      const { rate: satoshiToJPY, timestamp: exchangeRateTimestamp } = await getBTCtoJPYRate(false, true);
      const totalPriceJPY = Math.round(totalPrice * satoshiToJPY);
      res.json({
        message: 'Fetched order detail',
        order: {
          ...order,
          pricePerHour,
          pricePer5Min,
          totalPrice,
          totalPriceJPY,
          exchangeRateTimestamp
        },
        exchangeRateTimestamp
      });
    } catch (error) {
      next(error);
    }
  })
);

// オーダー更新 (認証必須)
router.put('/:id',
  apiKeyAuth,
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  allowOwnerOrAdmin((req) => OrderRepository.getById(req.params.id)),
  asyncHandler(async (req, res) => {
    const order = req.resource;
    logger.info(`Updating order: ${order.id}`);
    // 入力値サニタイズ
    const sanitized = sanitizeObject(req.body, ['description']);
    // 状態遷移チェック
    if (sanitized.status && sanitized.status !== order.status) {
      if (!isValidOrderTransition(order.status, req.body.status)) {
        return res.status(400).json({ error: `Invalid status transition from ${order.status} to ${req.body.status}` });
      }
    }
    // オーダーを更新
    const updatedOrder = OrderRepository.update(order.id, { ...order, ...sanitized });
    logger.info(`Order updated: ${order.id}`);
    res.json({
      message: 'Order updated successfully',
      order: updatedOrder
    });
  })
);

// オーダー削除 (認証必須)
router.delete('/:id',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  allowOwnerOrAdmin((req) => OrderRepository.getById(req.params.id)),
  asyncHandler(async (req, res) => {
    const order = req.resource;
    logger.info(`Deleting order: ${order.id}`);
    // 状態チェック
    const { APIError, ErrorTypes } = require('../../../utils/error-handler');
    if (!['pending', 'matched'].includes(order.status)) {
      throw new APIError(ErrorTypes.VALIDATION, 'Only pending or matched orders can be deleted', 400);
    }
    const deleted = OrderRepository.delete(order.id);
    if (!deleted) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    }
    logger.info(`Order deleted: ${order.id}`);
    res.json({ message: 'Order deleted', orderId: order.id });
  })
);

// オーダー作成 (認証必須)
router.post('/', 
  apiKeyAuth,
  authenticateJWT,
  validateMiddleware(schemas.order.create),
  asyncHandler(async (req, res) => {
    // 入力値サニタイズ
    const orderData = sanitizeObject(req.validatedBody, ['description']);
    logger.info('Creating new order');
    // durationMinutes必須・5の倍数・整数のみ許可
    const durationMinutes = Number(orderData.durationMinutes);
    const { APIError, ErrorTypes } = require('../../../utils/error-handler');
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes % 5 !== 0) {
      throw new APIError(ErrorTypes.VALIDATION, 'durationMinutes must be a positive integer and a multiple of 5 (minutes)', 400);
    }
    orderData.durationMinutes = durationMinutes;

    // gpuId必須化（maxPricePerHourとの排他チェック）
    if (!orderData.gpuId) {
      throw new APIError(ErrorTypes.VALIDATION, 'gpuId is required', 400);
    }
    if (orderData.gpuId && orderData.maxPricePerHour) {
      throw new APIError(ErrorTypes.VALIDATION, 'Specify either gpuId or maxPricePerHour, not both', 400);
    }

    // GPUの存在チェック
    const GpuRepository = require('../../../db/json/GpuRepository');
    const gpu = GpuRepository.getById(orderData.gpuId);
    if (!gpu) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Specified GPU not found', 404);
    }
    // 料金計算: GPUのpricePerHour必須
    let pricePerHour = gpu.pricePerHour;
    if (!pricePerHour || typeof pricePerHour !== 'number' || pricePerHour <= 0) {
      throw new APIError(ErrorTypes.VALIDATION, 'GPU pricePerHour must be a positive number', 400);
    }

    // ユーザーIDを設定
    orderData.userId = req.user.id;
    // オーダーステータスを設定
    orderData.status = 'pending';
    // 5分単価
    const pricePer5Min = pricePerHour / 12;
    const totalPrice = pricePer5Min * (durationMinutes / 5);
    // 冗長化為替APIで換算（キャッシュ活用）
    const { getBTCtoJPYRate } = require('../../../utils/exchange-rate');
    const satoshiToJPY = await getBTCtoJPYRate();
    const totalPriceJPY = Math.round(totalPrice * satoshiToJPY);
    // ファイル永続化リポジトリで作成
    orderData.totalPrice = totalPrice;
    orderData.totalPriceJPY = totalPriceJPY;
    const createdOrder = OrderRepository.create(orderData);
    // 通知サービス呼び出し
    const { sendNotification, NotifyType } = require('../../../utils/notifier');
    const notifyMsg = `新規注文: #${createdOrder.id}\nユーザー: ${req.user.id}\nGPU: ${gpu.name}\n時間: ${durationMinutes}分\n合計: ${totalPrice} sat (${totalPriceJPY}円)`;
    // メール通知（ユーザーのメールアドレスが取得できる場合のみ）
    if (req.user.email) {
      sendNotification(NotifyType.EMAIL, notifyMsg, {
        to: req.user.email,
        subject: `【Strawberry】新規注文 #${createdOrder.id} 受付通知`,
        text: notifyMsg
      }).catch(() => {});
    }
    // 環境変数から通知先を取得（例: LINE_TOKEN, DISCORD_WEBHOOK, SLACK_WEBHOOK, GENERIC_WEBHOOK）
    if (process.env.LINE_TOKEN) {
      sendNotification(NotifyType.LINE, notifyMsg, { token: process.env.LINE_TOKEN }).catch(() => {});
    }
    if (process.env.DISCORD_WEBHOOK) {
      sendNotification(NotifyType.DISCORD, notifyMsg, { webhookUrl: process.env.DISCORD_WEBHOOK }).catch(() => {});
    }
    if (process.env.SLACK_WEBHOOK) {
      sendNotification(NotifyType.SLACK, notifyMsg, { webhookUrl: process.env.SLACK_WEBHOOK }).catch(() => {});
    }
    if (process.env.GENERIC_WEBHOOK) {
      sendNotification(NotifyType.WEBHOOK, notifyMsg, { webhookUrl: process.env.GENERIC_WEBHOOK }).catch(() => {});
    }
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      sendNotification(NotifyType.TELEGRAM, notifyMsg, {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
      }).catch(() => {});
    }
    // Googleカレンダー連携（非同期で実行、失敗はログのみ）
    try {
      const { addEventToCalendar } = require('../../../utils/google-calendar');
      const startDate = new Date();
      const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
      addEventToCalendar({
        summary: `GPU予約 #${createdOrder.id}`,
        description: `ユーザー: ${req.user.id}\nGPU: ${gpu.name}\n合計: ${totalPrice} sat (${totalPriceJPY}円)`,
        start: { dateTime: startDate.toISOString() },
        end: { dateTime: endDate.toISOString() },
      }).catch(err => logger.error('Googleカレンダー登録失敗', { error: err.message }));
    } catch (e) {
      logger.error('Googleカレンダー連携モジュール読込失敗', { error: e.message });
    }
    // オーダーイベントをログに記録
    logger.info(`Order created: ${createdOrder.id}`, {
      orderId: createdOrder.id,
      userId: req.user.id,
      gpuRequirements: createdOrder.gpuRequirements,
      pricePerHour,
      durationMinutes,
      totalPrice,
      totalPriceJPY
    });
    res.status(201).json({
      message: 'Order created successfully',
      orderId: createdOrder.id,
      order: {
        ...createdOrder,
        pricePerHour,
        pricePer5Min,
        totalPrice,
        totalPriceJPY
      }
    });
  })
);

// マッチング要求 (認証必須)
router.post('/:id/match', 
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid().required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    logger.info(`Requesting matching for order: ${orderId}`);
    
    // オーダー情報を取得
    const order = await p2pNetwork.getOrderById(orderId);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    // オーダーの所有者確認
    if (req.user.role !== 'admin' && order.userId !== req.user.id) {
      return res.status(403).json({ error: 'You do not have permission to match this order' });
    }
    
    // オーダーがpending状態であることを確認
    if (order.status !== 'pending') {
      return res.status(400).json({ 
        error: 'Order cannot be matched',
        details: `Current status: ${order.status}`
      });
    }
    
    // P2Pネットワークでマッチング実行
    const matchResult = await p2pNetwork.matchOrder(orderId);
    
    if (!matchResult || !matchResult.matched) {
      return res.json({ 
        matched: false,
        message: 'No suitable GPU found for this order'
      });
    }
    
    // マッチング成功
    // オーダーステータスを更新
    await p2pNetwork.updateOrder(orderId, { 
      status: 'matched',
      gpuId: matchResult.gpu.id,
      providerId: matchResult.gpu.providerId,
      matchedAt: new Date().toISOString()
    });
    
    // マッチングイベントをログに記録
    logger.info(`Order matched: ${orderId}`, {
      orderId,
      userId: req.user.id,
      gpuId: matchResult.gpu.id,
      providerId: matchResult.gpu.providerId
    });
    
    res.json({
      matched: true,
      message: 'Order successfully matched with GPU',
      matchResult
    });
  })
);

// オーダー実行開始 (認証必須)
const Joi = require('joi');

router.post('/:id/start', 
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid().required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    logger.info(`Starting order execution: ${orderId}`);
    
    // オーダー情報を取得
    const order = await p2pNetwork.getOrderById(orderId);
    
    const { APIError, ErrorTypes } = require('../../../utils/error-handler');
    if (!order) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    }
    
    // オーダーの所有者確認
    if (req.user.role !== 'admin' && order.userId !== req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'You do not have permission to start this order', 403);
    }
    
    // オーダーがmatched状態であることを確認
    if (order.status !== 'matched') {
      return res.status(400).json({ 
        error: 'Order cannot be started',
        details: `Current status: ${order.status}`
      });
    }
    
    // GPUを割り当て
    const allocation = await vgpuManager.allocateGPU(order.gpuId, orderId);
    
    if (!allocation.success) {
      throw new APIError(ErrorTypes.INTERNAL, 'Failed to allocate GPU', 500, { details: allocation.message });
    }
    
    // オーダーステータスを更新
    await p2pNetwork.updateOrder(orderId, { 
      status: 'active',
      startedAt: new Date().toISOString(),
      allocationDetails: allocation
    });
    
    res.json({
      message: 'Order execution started successfully',
      allocationDetails: allocation
    });
  })
);

// オーダー実行終了 (認証必須)
router.post('/:id/stop', 
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid().required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    logger.info(`Stopping order execution: ${orderId}`);
    
    // オーダー情報を取得
    const order = await p2pNetwork.getOrderById(orderId);
    
    const { APIError, ErrorTypes } = require('../../../utils/error-handler');
    if (!order) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    }
    
    // オーダーの所有者確認
    if (req.user.role !== 'admin' && order.userId !== req.user.id) {
      throw new APIError(ErrorTypes.FORBIDDEN, 'You do not have permission to stop this order', 403);
    }
    
    // オーダーがactive状態であることを確認
    if (order.status !== 'active') {
      throw new APIError(
        ErrorTypes.VALIDATION,
        'Order cannot be stopped',
        400,
        { details: `Current status: ${order.status}` }
      );
    }
    
    // GPUを解放
    const release = await vgpuManager.releaseGPU(order.gpuId, orderId);
    
    // 使用統計を取得
    const usageStats = await vgpuManager.getGPUUsageStats(order.gpuId, orderId);
    
    // オーダーステータスを更新
    await p2pNetwork.updateOrder(orderId, { 
      status: 'completed',
      stoppedAt: new Date().toISOString(),
      usageStats
    });
    
    res.json({
      message: 'Order execution stopped successfully',
      usageStats
    });
  })
);

module.exports = router;
