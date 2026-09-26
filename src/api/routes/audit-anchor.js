// src/api/routes/audit-anchor.js
// 監査ログの Merkle アンカー + OpenTimestamps 提出の管理 API（§18）。
// アンカー root・エントリ範囲・OTS receipt の状態を admin が照会/手動駆動できる。
// これらは運用上の機微情報（監査ログの存在・量・提出状況）なので全て admin 限定。
const express = require('express');
const router = express.Router();
const rbac = require('../middleware/rbac');
const { anchorNewEntries, readAnchors, verifyEntryInclusion } = require('../../security/audit-anchor');
const ots = require('../../security/ots-submitter');

const isProd = process.env.NODE_ENV === 'production';
const internalError = (e) => (isProd ? 'Internal server error' : e.message || 'Internal server error');

const adminOnly = rbac('admin');

// 手動で増分アンカーを生成し OTS へ提出する。
// POST /api/v1/audit/anchors
router.post('/anchors', adminOnly, async (req, res) => {
  try {
    const result = await ots.anchorAndSubmit();
    if (!result) return res.json({ created: false, reason: 'no new audit entries' });
    return res.status(201).json({ created: true, anchor: result.anchor, ots: result.receipt });
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
});

// アンカー一覧 + OTS 提出状況のサマリ。
// GET /api/v1/audit/anchors
router.get('/anchors', adminOnly, (req, res) => {
  try {
    return res.json({ anchors: readAnchors(), ots: ots.getOtsStatus() });
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
});

// pending receipts をカレンダーへ照合し Bitcoin 確定を反映する。
// POST /api/v1/audit/anchors/upgrade
router.post('/anchors/upgrade', adminOnly, async (req, res) => {
  try {
    return res.json(await ots.upgradePending());
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
});

// 包含証明の検証: {entry, proof, root} → {valid}。第三者が「その時点のアンカーに
// この監査エントリが含まれていたか」を検査するための純関数エンドポイント。
// POST /api/v1/audit/anchors/verify
router.post('/anchors/verify', adminOnly, (req, res) => {
  const { entry, proof, root } = req.body || {};
  if (entry === undefined || !Array.isArray(proof) || typeof root !== 'string') {
    return res.status(400).json({ error: 'entry, proof (array), root (hex string) are required' });
  }
  try {
    return res.json({ valid: verifyEntryInclusion(entry, proof, root) });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

module.exports = router;
