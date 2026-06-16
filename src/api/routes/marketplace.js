// src/api/routes/marketplace.js
// マーケットプレイス・ドメイン API（docs/SPECIFICATION.md §6-2 配線）。
// marketplace-service を HTTP で公開する薄いラッパ。/api/v1 配下にマウントされ JWT 必須。
// 既存の order/payment ルートは変更せず、新規追加エンドポイントとして提供する（低リスク）。
const express = require('express');
const router = express.Router();
const marketplace = require('../../marketplace/default');
const rbac = require('../middleware/rbac');

const isProd = process.env.NODE_ENV === 'production';
// バリデーション由来の想定内エラー（400）は e.message をそのまま返す。
// 未想定の内部エラー（5xx）は本番では詳細を隠す。
const clientError = (e) => e.message || 'Invalid request';
const internalError = (e) => isProd ? 'Internal server error' : (e.message || 'Internal server error');

// エスクロー操作は資金フローに直結するため admin 限定
const adminOnly = rbac('admin');

// 特徴量ベースの価格見積（読み取りのみ）
router.post('/quote', (req, res) => {
  const { gpu, market } = req.body || {};
  if (!gpu || typeof gpu !== 'object' || Array.isArray(gpu)) {
    return res.status(400).json({ error: 'gpu object is required' });
  }
  try {
    return res.json(marketplace.quoteGpu(gpu, market && typeof market === 'object' ? market : {}));
  } catch (e) {
    // quoteGpu はユーザー入力の数値検証でのみ投げる想定 → 400
    return res.status(400).json({ error: clientError(e) });
  }
});

// プロバイダ群をレピュテーション順に並べる（マッチング補助）
router.post('/rank', (req, res) => {
  const { providerIds, opts } = req.body || {};
  if (!Array.isArray(providerIds)) {
    return res.status(400).json({ error: 'providerIds array is required' });
  }
  try {
    return res.json({ ranked: marketplace.rankCandidates(providerIds, opts && typeof opts === 'object' ? opts : {}) });
  } catch (e) {
    return res.status(400).json({ error: clientError(e) });
  }
});

// 逆オークションでプロバイダを選定（Akash/Golem 型マッチング）
// bid に reputationScore が無ければ reputationService から自動補完される
router.post('/auction', (req, res) => {
  const { bids, opts } = req.body || {};
  if (!Array.isArray(bids)) {
    return res.status(400).json({ error: 'bids array is required' });
  }
  try {
    return res.json(marketplace.selectProvider(bids, opts && typeof opts === 'object' ? opts : {}));
  } catch (e) {
    return res.status(400).json({ error: clientError(e) });
  }
});

// --- エスクロー・ライフサイクル（admin 限定）---

// 注文に価格を確定し hold-invoice エスクローを開く（PENDING）
// エスクロー amountSats は注文作成時に合意した totalPrice から取る。
// リクエスト body の gpu/durationMinutes から再計算すると GPU 値上げ後に
// escrow.amountSats ≠ order.totalPrice となり係争時の精算額が狂う。
router.post('/escrow/open', adminOnly, (req, res) => {
  const { orderId, feeRate } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });
  try {
    const OrderRepository = require('../../db/json/OrderRepository');
    const GpuRepository = require('../../db/json/GpuRepository');
    const order = OrderRepository.getById(orderId);
    if (!order) return res.status(404).json({ error: 'order not found' });
    if (typeof order.totalPrice !== 'number' || order.totalPrice <= 0) {
      return res.status(422).json({ error: 'order.totalPrice is not set; cannot open escrow' });
    }
    const gpu = GpuRepository.getById(order.gpuId) || {};
    const result = marketplace.openOrderEscrow({
      orderId,
      providerId: order.providerId || null,
      gpu,
      durationMinutes: order.durationMinutes || 0,
      market: {},
      feeRate: Number(feeRate) || 0,
      // Override the quote-based amountSats with the price-locked order total
      amountSatOverride: order.totalPrice,
    });
    return res.status(201).json(result);
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
});

// エスクロー状態取得
router.get('/escrow/:id', adminOnly, (req, res) => {
  const escrow = marketplace.getEscrow(req.params.id);
  if (!escrow) return res.status(404).json({ error: 'escrow not found' });
  return res.json(escrow);
});

// hold invoice 入金（PENDING→HELD）
router.post('/escrow/:id/pay', adminOnly, (req, res) => {
  try {
    return res.json(marketplace.recordPaid(req.params.id));
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
});

// ジョブ結果を検証してエスクローを解放/係争へ
router.post('/escrow/:id/verify', adminOnly, (req, res) => {
  const { jobId, providerId, primaryOutput, utilSamples, replicas, auditRate } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  try {
    const result = marketplace.verifyAndSettle({
      jobId,
      escrowId: req.params.id,
      providerId: providerId || null,
      primaryOutput,
      utilSamples: Array.isArray(utilSamples) ? utilSamples : [],
      replicas: Array.isArray(replicas) ? replicas : [],
      auditRate: typeof auditRate === 'number' ? auditRate : undefined,
    });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
});

// 係争の解決（settle / refund）
router.post('/escrow/:id/resolve', adminOnly, (req, res) => {
  const { decision, providerId } = req.body || {};
  if (decision !== 'settle' && decision !== 'refund') {
    return res.status(400).json({ error: "decision must be 'settle' or 'refund'" });
  }
  try {
    // providerId が渡された場合、エスクローの注文に記録された実際のプロバイダと一致するか検証する。
    // 不一致を許すと admin が任意の providerId を指定して無関係プロバイダの reputation を slash できてしまう。
    if (providerId) {
      const escrow = marketplace.getEscrow(req.params.id);
      if (!escrow) return res.status(404).json({ error: 'escrow not found' });
      const OrderRepository = require('../../db/json/OrderRepository');
      const order = OrderRepository.getById(escrow.orderId);
      if (order && order.providerId && order.providerId !== providerId) {
        return res.status(400).json({ error: 'providerId does not match the escrow order provider' });
      }
    }
    return res.json(marketplace.resolveDispute(req.params.id, decision, providerId || null));
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
});

// パブリック市場統計（認証不要 — マーケットブラウジング用）
// GET /marketplace/stats — GPU 供給・需要・価格帯の概要
router.get('/stats', (req, res) => {
  try {
    const GpuRepository = require('../../db/json/GpuRepository');
    const OrderRepository = require('../../db/json/OrderRepository');

    const allGpus = GpuRepository.getAll();
    const allOrders = OrderRepository.getAll();
    const nowMs = Date.now();
    const BLOCKING = new Set(['pending', 'matched', 'active']);

    const occupiedGpuIds = new Set(
      allOrders.filter(o => {
        if (!BLOCKING.has(o.status)) return false;
        const s = new Date(o.scheduledStartAt || o.createdAt).getTime();
        const e = s + (o.durationMinutes || 0) * 60 * 1000;
        return s <= nowMs && e > nowMs;
      }).map(o => o.gpuId)
    );

    const availableGpus = allGpus.filter(g => g.available !== false && !occupiedGpuIds.has(g.id));
    const prices = availableGpus.map(g => g.pricePerHour).filter(p => typeof p === 'number' && p > 0);
    const avgPrice = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : null;
    const minPrice = prices.length ? Math.min(...prices) : null;
    const maxPrice = prices.length ? Math.max(...prices) : null;

    // GPU別完了注文数・収益の集計（トップGPU）
    const gpuStats = {};
    for (const o of allOrders) {
      if (o.status !== 'completed' || !o.gpuId) continue;
      if (!gpuStats[o.gpuId]) gpuStats[o.gpuId] = { completedOrders: 0, totalSats: 0 };
      gpuStats[o.gpuId].completedOrders++;
      gpuStats[o.gpuId].totalSats += typeof o.totalPrice === 'number' ? o.totalPrice : 0;
    }
    const topGpus = Object.entries(gpuStats)
      .map(([gpuId, s]) => {
        const gpu = GpuRepository.getById(gpuId);
        return { gpuId, gpuName: gpu ? gpu.name : null, vendor: gpu ? gpu.vendor : null, ...s };
      })
      .sort((a, b) => b.completedOrders - a.completedOrders)
      .slice(0, 10);

    // 販売者別のベンダー分布
    const vendorCounts = {};
    for (const g of allGpus) {
      if (g.vendor) vendorCounts[g.vendor] = (vendorCounts[g.vendor] || 0) + 1;
    }

    res.json({
      totalGpus: allGpus.length,
      availableGpus: availableGpus.length,
      occupiedGpus: allGpus.filter(g => occupiedGpuIds.has(g.id)).length,
      pricing: { avgPricePerHour: avgPrice ? Math.round(avgPrice * 10000) / 10000 : null, minPricePerHour: minPrice, maxPricePerHour: maxPrice },
      vendorDistribution: vendorCounts,
      topGpusByCompletedOrders: topGpus,
      pendingOrders: allOrders.filter(o => o.status === 'pending').length,
    });
  } catch (e) {
    res.status(500).json({ error: isProd ? 'Internal server error' : e.message });
  }
});

module.exports = router;
