// src/api/routes/marketplace.js
// マーケットプレイス・ドメイン API（docs/SPECIFICATION.md §6-2 配線）。
// marketplace-service を HTTP で公開する薄いラッパ。/api/v1 配下にマウントされ JWT 必須。
// 既存の order/payment ルートは変更せず、新規追加エンドポイントとして提供する（低リスク）。
const express = require('express');
const router = express.Router();
const marketplace = require('../../marketplace/default');
const rbac = require('../middleware/rbac');

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
    return res.status(400).json({ error: e.message });
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
    return res.status(400).json({ error: e.message });
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
    return res.status(400).json({ error: e.message });
  }
});

// --- エスクロー・ライフサイクル（admin 限定）---

// 注文に価格を確定し hold-invoice エスクローを開く（PENDING）
router.post('/escrow/open', adminOnly, (req, res) => {
  const { orderId, providerId, gpu, durationMinutes, market, feeRate } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });
  if (!gpu || typeof gpu !== 'object' || Array.isArray(gpu)) {
    return res.status(400).json({ error: 'gpu object is required' });
  }
  try {
    const result = marketplace.openOrderEscrow({
      orderId,
      providerId: providerId || null,
      gpu,
      durationMinutes: Number(durationMinutes) || 0,
      market: market && typeof market === 'object' ? market : {},
      feeRate: Number(feeRate) || 0,
    });
    return res.status(201).json(result);
  } catch (e) {
    return res.status(400).json({ error: e.message });
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
    return res.status(400).json({ error: e.message });
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
    return res.status(400).json({ error: e.message });
  }
});

// 係争の解決（settle / refund）
router.post('/escrow/:id/resolve', adminOnly, (req, res) => {
  const { decision, providerId } = req.body || {};
  if (decision !== 'settle' && decision !== 'refund') {
    return res.status(400).json({ error: "decision must be 'settle' or 'refund'" });
  }
  try {
    return res.json(marketplace.resolveDispute(req.params.id, decision, providerId || null));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

module.exports = router;
