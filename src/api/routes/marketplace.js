// src/api/routes/marketplace.js
// マーケットプレイス・ドメイン API（docs/SPECIFICATION.md §6-2 配線）。
// marketplace-service を HTTP で公開する薄いラッパ。/api/v1 配下にマウントされ JWT 必須。
//
// hold-invoice エスクローのライフサイクル・ルート（/escrow/open, /escrow/:id,
// /escrow/:id/pay, /escrow/:id/verify, /escrow/:id/resolve）は削除した。
// 理由: hold-invoice/HTLC エスクローはトラストレス機構であり、運営のLightning
// ノードへ入金し運営が payout-ledger.js で後払いする本製品の custodial 設計とは
// 要件として噛み合わず、実注文でも一度も使われていなかった。
// 詳細は ARCHITECTURE.md「エスクロー機構の削除」節を参照。
const express = require('express');
const router = express.Router();
const marketplace = require('../../marketplace/default');

const clientError = (e) => e.message || 'Invalid request';

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

// 逆オークションのエンドポイント（POST /marketplace/auction）は削除した。
//
// この製品には**入札という概念が存在しない**: GPU は固定価格で出品され、入札を
// 保存する場所も、貸し手が借り手の要件を見る画面も、入札の有効期限も無い。
// 旧エンドポイントは「入札の配列」をリクエストボディから受け取っており、
// 価格を含めて呼び出し側が捏造できた（＝返る「落札者」は何も意味しない）。
// 実在しない機能を API と仕様書が「実装済み」と称している状態だった。
//
// 有用だったのは中身の効用スコア（価格×レピュテーション×稼働×アテステーション）
// の方なので、それは残して GET /gpus?sort=recommended に移した。そちらは
// サーバが持っている実データで実在の出品を並べる。auction-engine.js のテストは
// 純関数として引き続き有効。

module.exports = router;
