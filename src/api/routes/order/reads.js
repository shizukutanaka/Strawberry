// src/api/routes/order/reads.js - オーダー読み取り系エンドポイント
// （一覧・統計・収益・単体・決済情報取得）。遅延スイープのスロットル状態は
// GET / のみが使うためこのモジュールに閉じている。
const express = require('express');
const router = express.Router();

const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole, allowOwnerOrAdmin } = require('../../middleware/security');
const { vgpuManager } = require('../../../core/services');
const OrderRepository = require('../../../db/json/OrderRepository');
const EscrowRepository = require('../../../db/json/EscrowRepository');
const GpuRepository = require('../../../db/json/GpuRepository');
const PaymentRepository = require('../../../db/json/PaymentRepository');
const { fetchRateInfo, computeOrderPricing } = require('../../../utils/order-pricing');
const { expireStaleOrders, expireStaleMatchedOrders, expireStaleDisputedOrders, expireStaleActiveOrders } = require('../../../utils/order-expiry');
const { cacheMiddleware } = require('../../middleware/cache');

// オーダー一覧取得 (認証必須)
// キャッシュは perUser 必須: URL のみをキーにすると先行ユーザーの注文一覧が
// 他ユーザーに返る（認可バイパス）ため、ユーザーIDをキーに含める。

// Stale-order sweeps are O(N orders) reads + writes per call. Triggering them on
// every GET /orders amplified into a 4-sweep DoS — a fresh role:'user' token could
// hammer ?offset=$i (bypassing the perUser cache via varying querystring) and force
// 4×N IO per request. Throttle to once per SWEEP_THROTTLE_MS process-wide.
const SWEEP_THROTTLE_MS = process.env.NODE_ENV === 'test' ? 0 : 30_000;
let _lastOrderSweepAt = 0;
router.get('/',
  authenticateJWT,
  cacheMiddleware({ perUser: true }),
  asyncHandler(async (req, res, next) => {
    try {
      logger.info('Fetching orders');
      // 期限切れ pending/matched 注文を失効させてから一覧を返す（遅延スイープ）。
      // 30 秒に 1 回だけ実行し、リクエストごとの 4×N スキャン増幅を遮断する。
      if (Date.now() - _lastOrderSweepAt > SWEEP_THROTTLE_MS) {
        _lastOrderSweepAt = Date.now();
        expireStaleOrders();
        expireStaleMatchedOrders();
        expireStaleDisputedOrders();
        // active タイムアウト: 返された各注文の GPU を解放する（vgpuManager 利用可能時のみ）
        const timedOutActive = expireStaleActiveOrders();
        if (vgpuManager && timedOutActive.length > 0) {
          for (const { id: oid, gpuId } of timedOutActive) {
            try { await vgpuManager.releaseGPU(gpuId, oid); } catch (_) {}
          }
        }
      }
      let orders;
      if (req.user.role === 'admin') {
        orders = OrderRepository.getAll();
        // 管理者はユーザーIDやプロバイダIDで絞り込み可能（サポートワークフロー）
        if (req.query.userId) orders = orders.filter(o => o.userId === req.query.userId);
        if (req.query.providerId) orders = orders.filter(o => o.providerId === req.query.providerId);
      } else if (req.user.role === 'provider') {
        // プロバイダは自分が提供側の注文に加え、自分が借り手側の注文も閲覧できる。
        // ?role=provider でプロバイダ側のみ、?role=renter で借り手側のみ絞り込み可能。
        const allOrders = OrderRepository.getAll();
        if (req.query.role === 'provider') {
          orders = allOrders.filter(o => o.providerId === req.user.id);
        } else if (req.query.role === 'renter') {
          orders = allOrders.filter(o => o.userId === req.user.id);
        } else {
          const providerSet = new Set(allOrders.filter(o => o.providerId === req.user.id).map(o => o.id));
          const renterOrders = allOrders.filter(o => o.userId === req.user.id && !providerSet.has(o.id));
          orders = [...allOrders.filter(o => providerSet.has(o.id)), ...renterOrders];
        }
      } else {
        orders = OrderRepository.getByUserId(req.user.id);
      }
      const status = req.query.status;
      if (status) {
        orders = orders.filter(order => order.status === status);
      }
      // gpuId で絞り込み（全ロール対応 — プロバイダが特定 GPU の注文を確認する際に便利）
      if (req.query.gpuId) {
        orders = orders.filter(order => order.gpuId === req.query.gpuId);
      }
      // 日付範囲フィルタ（from=ISO&to=ISO — createdAt ベース）
      if (req.query.from) {
        const fromMs = Date.parse(req.query.from);
        if (!Number.isFinite(fromMs)) return res.status(400).json({ error: 'Invalid "from" date' });
        orders = orders.filter(o => Date.parse(o.createdAt) >= fromMs);
      }
      if (req.query.to) {
        const toMs = Date.parse(req.query.to);
        if (!Number.isFinite(toMs)) return res.status(400).json({ error: 'Invalid "to" date' });
        orders = orders.filter(o => Date.parse(o.createdAt) <= toMs);
      }
      const SORTABLE_FIELDS = new Set(['createdAt', 'updatedAt', 'status', 'totalPrice', 'durationMinutes']);
      const sortBy = SORTABLE_FIELDS.has(req.query.sortBy) ? req.query.sortBy : 'createdAt';
      const sortDir = req.query.sortDir === 'asc' ? 1 : -1;
      orders.sort((a, b) => {
        if (a[sortBy] < b[sortBy]) return -1 * sortDir;
        if (a[sortBy] > b[sortBy]) return 1 * sortDir;
        return 0;
      });
      // ページネーション（limit: 1..200 既定50 / offset: 0..）
      const total = orders.length;
      const limitRaw = parseInt(req.query.limit, 10);
      const offsetRaw = parseInt(req.query.offset, 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
      const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.min(offsetRaw, 100000) : 0;
      orders = orders.slice(offset, offset + limit);
      // リアルタイムBTC/JPY換算（レートは一覧全体で1回だけ取得して使い回す）
      const rateInfo = await fetchRateInfo();
      const ordersWithPricing = orders.map(order => {
        const o = { ...order, ...computeOrderPricing(order, rateInfo) };
        // Strip reviewerId from review sub-objects: it is the reviewer's internal UUID.
        // Exposing it to the counterparty breaks reviewer anonymity — they can cross-reference
        // with the renter's order history to identify who left a specific review.
        if (o.review) o.review = { ...o.review, reviewerId: undefined };
        if (o.renterReview) o.renterReview = { ...o.renterReview, reviewerId: undefined };
        return o;
      });
      res.json({
        message: 'Fetched orders',
        total,
        limit,
        offset,
        orders: ordersWithPricing,
        exchangeRateTimestamp: rateInfo.timestamp
      });
    } catch (error) {
      next(error);
    }
  })
);

// ユーザー自身の注文統計 (認証必須 — 全ロール)
// 借り手として: 総支出・完了件数・キャンセル件数・係争件数
// 提供者として: 収益サマリは /provider/earnings を参照（こちらはより軽量）

router.get('/stats',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const allOrders = OrderRepository.getAll();

    const asRenter = allOrders.filter(o => o.userId === userId);
    const asProvider = req.user.role === 'provider' || req.user.role === 'admin'
      ? allOrders.filter(o => o.providerId === userId)
      : [];

    const countByStatus = (orders) => {
      const counts = {};
      for (const o of orders) {
        counts[o.status] = (counts[o.status] || 0) + 1;
      }
      return counts;
    };

    const totalSpentSats = asRenter
      .filter(o => o.status === 'completed')
      .reduce((s, o) => s + (typeof o.totalPrice === 'number' ? o.totalPrice : 0), 0);
    const totalSpentJPY = asRenter
      .filter(o => o.status === 'completed')
      .reduce((s, o) => s + (typeof o.totalPriceJPY === 'number' ? o.totalPriceJPY : 0), 0);

    const totalEarnedSats = asProvider
      .filter(o => o.status === 'completed')
      .reduce((s, o) => s + (typeof o.totalPrice === 'number' ? o.totalPrice : 0), 0);
    const totalEarnedJPY = asProvider
      .filter(o => o.status === 'completed')
      .reduce((s, o) => s + (typeof o.totalPriceJPY === 'number' ? o.totalPriceJPY : 0), 0);

    res.json({
      userId,
      asRenter: {
        total: asRenter.length,
        byStatus: countByStatus(asRenter),
        totalSpentSats,
        totalSpentJPY,
      },
      // 提供者・管理者は asProvider を常に返す（件数 0 でも null にしない）
      asProvider: (req.user.role === 'provider' || req.user.role === 'admin') ? {
        total: asProvider.length,
        byStatus: countByStatus(asProvider),
        totalEarnedSats,
        totalEarnedJPY,
      } : null,
    });
  })
);

// プロバイダ収益サマリ (認証必須, provider/admin)
// 自身が providerId の注文を集計し、完了済み収益と進行中の見込み額を返す。

router.get('/provider/earnings',
  authenticateJWT,
  checkRole(['provider', 'admin']),
  asyncHandler(async (req, res) => {
    const providerId = req.user.id;
    // 任意の日付範囲フィルタ（from=ISO&to=ISO）
    const fromMs = req.query.from ? Date.parse(req.query.from) : null;
    const toMs = req.query.to ? Date.parse(req.query.to) : null;
    if (req.query.from && isNaN(fromMs)) {
      return res.status(400).json({ error: 'Invalid from date' });
    }
    if (req.query.to && isNaN(toMs)) {
      return res.status(400).json({ error: 'Invalid to date' });
    }
    let orders = OrderRepository.getAll().filter(o => o.providerId === providerId);
    if (fromMs) orders = orders.filter(o => Date.parse(o.createdAt) >= fromMs);
    if (toMs) orders = orders.filter(o => Date.parse(o.createdAt) <= toMs);
    const summary = {
      providerId,
      from: req.query.from || null,
      to: req.query.to || null,
      completedCount: 0,
      completedSats: 0,
      completedJPY: 0,
      activeCount: 0,
      activeSats: 0,
      cancelledCount: 0,
    };
    for (const o of orders) {
      const sats = typeof o.totalPrice === 'number' ? o.totalPrice : 0;
      if (o.status === 'completed') {
        summary.completedCount++;
        summary.completedSats += sats;
        summary.completedJPY += typeof o.totalPriceJPY === 'number' ? o.totalPriceJPY : 0;
      } else if (o.status === 'active') {
        summary.activeCount++;
        summary.activeSats += sats;
      } else if (o.status === 'cancelled') {
        summary.cancelledCount++;
      }
    }
    // GPU別収益内訳
    const byGpu = {};
    for (const o of orders) {
      if (o.status !== 'completed') continue;
      const gid = o.gpuId;
      if (!byGpu[gid]) byGpu[gid] = { gpuId: gid, gpuName: null, completedCount: 0, completedSats: 0, completedJPY: 0 };
      byGpu[gid].completedCount++;
      byGpu[gid].completedSats += typeof o.totalPrice === 'number' ? o.totalPrice : 0;
      byGpu[gid].completedJPY += typeof o.totalPriceJPY === 'number' ? o.totalPriceJPY : 0;
    }
    for (const entry of Object.values(byGpu)) {
      const gpu = GpuRepository.getById(entry.gpuId);
      entry.gpuName = gpu ? gpu.name : null;
    }
    summary.byGpu = Object.values(byGpu).sort((a, b) => b.completedSats - a.completedSats);

    res.json({ message: 'Provider earnings summary', earnings: summary });
  })
);

// --- ハートビート受付API ---
// POST /api/orders/:id/heartbeat { role: 'lender'|'renter' }

router.get('/:id',
  authenticateJWT,
  validateMiddleware(schemas.idParam, 'params'),
  allowOwnerOrAdmin((req) => OrderRepository.getById(req.params.id)),
  asyncHandler(async (req, res, next) => {
    try {
      logger.info(`Fetching order detail: ${req.params.id}`);
      const order = req.resource;
      const rateInfo = await fetchRateInfo();
      // 借り手プロフィール（プロバイダが承認/拒否判断に使えるよう注文詳細に同梱）
      const renterOrders = OrderRepository.getAll().filter(o => o.userId === order.userId && o.renterReview);
      const renterReviewCount = renterOrders.length;
      const renterRatingAverage = renterReviewCount > 0
        ? Math.round((renterOrders.reduce((s, o) => s + Math.min(5, Math.max(1, Number(o.renterReview.rating) || 1)), 0) / renterReviewCount) * 10) / 10
        : null;
      // ステータス変遷タイムライン（既存タイムスタンプを時系列に整列）
      const timeline = [
        { status: 'pending',   at: order.createdAt || null },
        { status: 'matched',   at: order.matchedAt || null },
        { status: 'active',    at: order.startedAt || null },
        { status: 'completed', at: order.completedAt || null },
        { status: 'cancelled', at: order.cancelledAt || null },
        { status: 'disputed',  at: order.dispute ? order.dispute.raisedAt : null },
      ].filter(e => e.at).sort((a, b) => a.at.localeCompare(b.at));
      res.json({
        message: 'Fetched order detail',
        order: {
          ...order,
          ...computeOrderPricing(order, rateInfo),
          renterProfile: { ratingAverage: renterRatingAverage, reviewCount: renterReviewCount },
          timeline,
        },
        exchangeRateTimestamp: rateInfo.timestamp
      });
    } catch (error) {
      next(error);
    }
  })
);

// オーダーの課金・エスクロー状況（注文当事者＝借り手/プロバイダ/管理者のみ）
// これまで支払状況は別の paymentId 経由（支払者しか知らない）、エスクローは管理者限定でしか
// 見えず、注文当事者が自分の注文の決済状態を確認できなかった。orderId 起点で一括照会する。

router.get('/:id/payment',
  authenticateJWT,
  validateMiddleware(schemas.idParam, 'params'),
  allowOwnerOrAdmin((req) => OrderRepository.getById(req.params.id)),
  asyncHandler(async (req, res) => {
    const order = req.resource;

    const payments = (PaymentRepository.getByOrderId(order.id) || []).map(p => ({
      id: p.id,
      status: p.status,
      amount: p.amount,
      method: p.method,
      paidAt: p.paidAt || null,
      invoiceExpiresAt: p.invoiceExpiresAt || null,
    }));
    const escrows = (EscrowRepository.getByOrderId(order.id) || []).map(e => ({
      id: e.id,
      state: e.state,
      amountSats: e.amountSats,
      feeRate: e.feeRate,
      createdAt: e.createdAt || null,
    }));

    res.json({
      orderId: order.id,
      orderStatus: order.status,
      totalPrice: typeof order.totalPrice === 'number' ? order.totalPrice : null,
      totalPriceJPY: typeof order.totalPriceJPY === 'number' ? order.totalPriceJPY : null,
      payments,
      escrows,
    });
  })
);

// オーダー更新 (認証必須)

module.exports = router;
