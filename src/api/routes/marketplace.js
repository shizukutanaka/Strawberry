// src/api/routes/marketplace.js
// マーケットプレイス・ドメイン API（docs/SPECIFICATION.md §6-2 配線）。
// marketplace-service を HTTP で公開する薄いラッパ。/api/v1 配下にマウントされ JWT 必須。
// 既存の order/payment ルートは変更せず、新規追加エンドポイントとして提供する（低リスク）。
const express = require('express');
const router = express.Router();
const marketplace = require('../../marketplace/default');

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

module.exports = router;
