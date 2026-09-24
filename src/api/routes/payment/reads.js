// src/api/routes/payment/reads.js - 決済状態・ノード情報の読み取り系エンドポイント
const express = require('express');
const router = express.Router();

const { asyncHandler, APIError, ErrorTypes } = require('../../../utils/error-handler');
const { parsePagination } = require('../../../utils/pagination');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');
const { lightning, requireService } = require('../../../core/services');
const PaymentRepository = require('../../../db/json/PaymentRepository');

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

// 支払い履歴取得（ページネーション対応: ?limit=N&offset=M、新しい順）

router.get('/history',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    logger.info('Fetching payment history');

    const raw = PaymentRepository.getByUserId(req.user.id) || [];
    // 新しい順
    const sorted = [...raw].sort((a, b) =>
      (b.paidAt || b.createdAt || '').localeCompare(a.paidAt || a.createdAt || ''));
    const total = sorted.length;
    const { limit, offset } = parsePagination(req.query);
    const page = sorted.slice(offset, offset + limit);
    const payments = page.map(payment => ({
      id: payment.id,
      orderId: payment.orderId,
      amount: payment.amount,
      status: payment.status,
      paymentHash: payment.paymentHash,
      paidAt: payment.paidAt
    }));
    res.json({ total, limit, offset, payments });
  })
);

// オンチェーンBTC決済（運営手数料控除）。
// 旧 routes/payment.js がディレクトリ解決を遮蔽（payment.js が payment/index.js より
// 優先）し、本ファイルの Lightning 決済API全体が未マウントになっていたため、
// /btc 配下のサブルートとして取り込んだ。グローバルJWTゲートの保護下にある。

module.exports = router;
