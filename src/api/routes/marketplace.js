// src/api/routes/marketplace.js
// マーケットプレイス・ドメイン API（docs/SPECIFICATION.md §6-2 配線）。
// marketplace-service を HTTP で公開する薄いラッパ。/api/v1 配下にマウントされ JWT 必須。
// 既存の order/payment ルートは変更せず、新規追加エンドポイントとして提供する（低リスク）。
const express = require('express');
const router = express.Router();
const marketplace = require('../../marketplace/default');
const rbac = require('../middleware/rbac');
const { withLock } = require('../../utils/async-lock');

const isProd = process.env.NODE_ENV === 'production';
// バリデーション由来の想定内エラー（400）は e.message をそのまま返す。
// 未想定の内部エラー（5xx）は本番では詳細を隠す。
const clientError = (e) => e.message || 'Invalid request';
const internalError = (e) => isProd ? 'Internal server error' : (e.message || 'Internal server error');

// エスクロー操作の例外を HTTP ステータスへ写像する。
//
// 以前はすべて 500 で返していたため、存在しない ID を渡しただけで
// 「サーバ障害」として報告されていた（全ルート走査で
// POST /escrow/:id/pay が 500 を返して発覚）。クライアントは自分の誤りと
// サーバの異常を区別できず、監視側は通常の 404 相当をエラー率に数えてしまう。
// escrow-service は業務上の失敗を Error のメッセージで表現するので、
// ここで既知の形だけを 4xx に落とし、それ以外は 500 のままにする。
function escrowErrorResponse(res, e) {
  const msg = (e && e.message) || '';
  if (/^escrow not found/i.test(msg)) {
    return res.status(404).json({ error: msg });
  }
  // 無効な状態遷移・二重オープン等は呼び出し側の誤りなので 409。
  if (/state changed concurrently|already exists for order|invalid transition|cannot .* from/i.test(msg)) {
    return res.status(409).json({ error: msg });
  }
  if (/required|must be/i.test(msg)) {
    return res.status(400).json({ error: msg });
  }
  return res.status(500).json({ error: internalError(e) });
}

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
    return escrowErrorResponse(res, e);
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
    return escrowErrorResponse(res, e);
  }
});

// ジョブ結果を検証してエスクローを解放/係争へ
// withLock で同一エスクローへの並行呼び出しによる二重遷移・二重払い出しを防ぐ
router.post('/escrow/:id/verify', adminOnly, async (req, res) => {
  const { jobId, providerId, primaryOutput, utilSamples, replicas, auditRate } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  try {
    const result = await withLock(`escrow:${req.params.id}`, () => marketplace.verifyAndSettle({
      jobId,
      escrowId: req.params.id,
      providerId: providerId || null,
      primaryOutput,
      utilSamples: Array.isArray(utilSamples) ? utilSamples : [],
      replicas: Array.isArray(replicas) ? replicas : [],
      auditRate: typeof auditRate === 'number' ? auditRate : undefined,
    }));
    return res.json(result);
  } catch (e) {
    return escrowErrorResponse(res, e);
  }
});

// 係争の解決（settle / refund）
// withLock で同一エスクローへの並行呼び出しによる二重 reputation slash を防ぐ（/verify と同様）
router.post('/escrow/:id/resolve', adminOnly, async (req, res) => {
  const { decision, providerId } = req.body || {};
  if (decision !== 'settle' && decision !== 'refund') {
    return res.status(400).json({ error: "decision must be 'settle' or 'refund'" });
  }
  try {
    const result = await withLock(`escrow:${req.params.id}`, async () => {
      // providerId が渡された場合、エスクローの注文に記録された実際のプロバイダと一致するか検証する。
      // 不一致を許すと admin が任意の providerId を指定して無関係プロバイダの reputation を slash できてしまう。
      if (providerId) {
        const escrow = marketplace.getEscrow(req.params.id);
        if (!escrow) throw Object.assign(new Error('escrow not found'), { status: 404 });
        const OrderRepository = require('../../db/json/OrderRepository');
        const order = OrderRepository.getById(escrow.orderId);
        if (order && order.providerId && order.providerId !== providerId) {
          throw Object.assign(new Error('providerId does not match the escrow order provider'), { status: 400 });
        }
      }
      return marketplace.resolveDispute(req.params.id, decision, providerId || null);
    });
    return res.json(result);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: status < 500 ? e.message : internalError(e) });
  }
});

module.exports = router;
