// 支払い・受取API（BTC差益自動控除）
const express = require('express');
const router = express.Router();
const { FEE_RATE, calcTotalWithFee, calcFee, calcPayout, sendBTC, getOperatorWallet } = require('../../utils/btc-payment');
const { appendAuditLog } = require('../../../utils/audit-log');
const { logger } = require('../../../utils/logger');
const { withLock } = require('../../../utils/async-lock');
const PaymentRepository = require('../../../db/json/PaymentRepository');

/**
 * POST /payment
 * body: { orderId, lenderWallet, borrowerWallet, priceBTC }
 * フロー: 借り手→運営（1.5%上乗せ）、運営→貸し手（純額）、利益は運営に残る
 *
 * 冪等性: 同一 orderId で再送しても安全。
 *   - SETTLED: キャッシュされた txid を即返却（tx は一切実行しない）
 *   - HELD   : tx1(借り手→運営)は記録済みのため tx2(運営→貸し手)のみリトライ
 * これにより tx2 の一時障害で資金が運営に滞留した場合、呼び出し元が同じリクエストを
 * 再送するだけで自動回復できる（手動照合不要）。
 */
router.post('/', async (req, res) => {
  try {
    const { orderId, borrowerWallet } = req.body;
    // Note: bodyLenderWallet is intentionally NOT destructured. The provider's
    // payout address is always derived server-side from provider.payoutAddress to
    // prevent a renter from redirecting the provider's funds to an attacker wallet.
    // priceBTC は受け付けない: ユーザーが任意金額を指定する価格操作を防ぐ。
    // 支払額は注文作成時にロックされた order.totalPrice（サトシ）から一意に決まる。
    if (!orderId || !borrowerWallet) {
      return res.status(400).json({ message: 'orderId and borrowerWallet are required' });
    }
    // ウォレットアドレスの基本フォーマット検証（空文字・過大入力を拒否）
    if (typeof borrowerWallet !== 'string' || borrowerWallet.length < 10 || borrowerWallet.length > 500) {
      return res.status(400).json({ message: 'Invalid borrowerWallet format' });
    }
    // 注文の所有者確認（認証必須 — グローバル jwtAuth が保証するが防御的に確認）
    const OrderRepository = require('../../../db/json/OrderRepository');
    const order = OrderRepository.getById(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!req.user || (req.user.role !== 'admin' && order.userId !== req.user.id)) {
      return res.status(403).json({ message: 'You do not have permission to pay for this order' });
    }
    // 注文状態ゲート: cancelled / completed / disputed 注文への二次支払いを拒否。
    // 旧実装は status を一切見なかったため、renter が
    //   POST /orders → DELETE /orders/:id → POST /payment/btc
    // の経路で「キャンセル済み注文の運営宛振替＋プロバイダへの自動 payout」を起こせた
    // （運営/プロバイダの口座を介した資金移送 + 借り手の元金喪失）。
    // pending/matched/active のみ許可。
    const ALLOWED_BTC_PAYMENT_STATUSES = new Set(['pending', 'matched', 'active']);
    if (!ALLOWED_BTC_PAYMENT_STATUSES.has(order.status)) {
      return res.status(409).json({
        message: `Cannot pay for order in '${order.status}' state via BTC on-chain`,
      });
    }
    // 二重決済防止: Lightning など他経路で paid 確定している注文に btc-onchain を
    // 再実行させない（追加トリプル送金を防ぐ）。btc_onchain 自身の PaymentRecord は
    // SETTLED エスクローのキャッシュ復帰パス（下の withLock 内）で処理されるため除外する
    // （btc_onchain は SETTLED エスクローを見つけて idempotent にキャッシュ済み結果を返す）。
    const crossMethodPaid = (PaymentRepository.getByOrderId(orderId) || [])
      .filter(p => p.status === 'paid' && p.method !== 'btc_onchain');
    if (crossMethodPaid.length > 0) {
      return res.status(409).json({
        message: 'Order has already been paid via another method (Lightning or manual approval)',
      });
    }

    // 二重課金防止: Lightning 経路と同一の per-order ミューテックスで保護する。
    // ロックなしだと並行リクエストが find(state!==CANCELED)===null を同時に通過し、
    // EscrowRepository.create() と sendBTC(TX1) を二重実行して借り手に二重課金する。
    return await withLock(`payment:${orderId}`, async () => {

    // 貸し手(プロバイダ)への送金先(lenderWallet)はサーバーが管理する provider.payoutAddress
    // のみを使用する。クライアント提供の bodyLenderWallet は一切受け付けない。
    // 旧実装は provider.payoutAddress 未設定時に bodyLenderWallet へフォールバックしており、
    // renter が lenderWallet フィールドで任意のウォレットを指定することで
    // provider の受取分(TX2)を第三者に横取りできた（クライアント制御の資金移送）。
    const UserRepository = require('../../../db/json/UserRepository');
    const provider = order.providerId ? UserRepository.getById(order.providerId) : null;
    const lenderWallet = provider && provider.payoutAddress ? provider.payoutAddress : null;
    if (!lenderWallet) {
      return res.status(400).json({
        message: 'No payout address available for this order. The GPU provider must register a payoutAddress (PUT /users/me) before payouts can be sent.'
      });
    }
    if (typeof lenderWallet !== 'string' || lenderWallet.length < 10 || lenderWallet.length > 500) {
      return res.status(400).json({ message: 'Invalid lenderWallet format' });
    }
    if (lenderWallet === borrowerWallet) {
      return res.status(400).json({
        message: 'Provider payoutAddress must differ from borrowerWallet; self-dealing is not permitted.'
      });
    }
    // order.totalPrice（サトシ）→ BTC 換算（1 BTC = 1e8 sat）
    if (!order.totalPrice || order.totalPrice <= 0) {
      return res.status(422).json({ message: 'Order has no valid total price; cannot process payment' });
    }
    const priceBTC = order.totalPrice / 1e8;
    const total = calcTotalWithFee(priceBTC);
    const fee = calcFee(priceBTC);
    const payout = calcPayout(priceBTC);
    const operatorWallet = getOperatorWallet();

    // ── エスクロー冪等性チェック ───────────────────────────────────────────────
    // tx1/tx2 の進捗を EscrowRepository に記録し、再送時に既済ステップを飛ばす。
    // PENDING: tx1 未送信  HELD: tx1 済み tx2 未送信  SETTLED: 完了
    const EscrowRepository = require('../../../db/json/EscrowRepository');
    const existingEscrows = EscrowRepository.getByOrderId(orderId);
    // 完了・進行中の最新エスクロー（CANCELED は無視して再開可能にする）
    let escrow = existingEscrows.find(e => e.state !== 'CANCELED') || null;

    if (escrow && escrow.state === 'SETTLED') {
      // 既に決済完了 — tx を一切実行せずキャッシュ結果を返す
      return res.json({
        message: 'Payment processed with operator fee',
        orderId,
        totalPaid: escrow.total,
        payout: escrow.payout,
        operatorFee: escrow.fee,
        txBorrowerToOperator: { txid: escrow.txBorrowerToOperator },
        txOperatorToLender: { txid: escrow.txOperatorToLender },
        escrowId: escrow.id,
        idempotent: true,
      });
    }

    if (!escrow) {
      escrow = EscrowRepository.create({
        orderId,
        amountSats: Math.round(total * 1e8),
        feeRate: FEE_RATE,
        state: 'PENDING',
        total,
        payout,
        fee,
        lenderWallet,
        operatorWallet,
      });
    }

    // ── TX1: 借り手 → 運営 ────────────────────────────────────────────────────
    const isProd = process.env.NODE_ENV === 'production';
    let tx1Txid;

    if (escrow.state === 'PENDING') {
      let tx1;
      try {
        tx1 = await sendBTC(borrowerWallet, operatorWallet, total);
      } catch (err) {
        return res.status(502).json({
          message: 'Payment failed before any funds were moved',
          stage: 'borrower_to_operator',
          escrowId: escrow.id,
          error: isProd ? 'Lightning payment failed' : err.message,
        });
      }
      tx1Txid = tx1.txid;
      // PENDING → HELD: tx1 txid を永続化してからリトライ安全状態へ
      EscrowRepository.updateIf(
        escrow.id,
        (e) => e.state === 'PENDING',
        { state: 'HELD', txBorrowerToOperator: tx1Txid, updatedAt: new Date().toISOString() }
      );
    } else {
      // HELD: tx1 は既に完了している（部分決済から再開）
      tx1Txid = escrow.txBorrowerToOperator;
      logger.info('[btc-onchain] Resuming partial settlement from tx2', { orderId, escrowId: escrow.id, tx1Txid });
    }

    // ── TX2: 運営 → 貸し手 ───────────────────────────────────────────────────
    let tx2Txid;
    try {
      const tx2 = await sendBTC(operatorWallet, lenderWallet, payout);
      tx2Txid = tx2.txid;
    } catch (err) {
      // 重大: tx1 は成立済み。同一リクエストを再送すれば tx2 のみリトライされ自動回復する。
      appendAuditLog('payment_partial_settlement', {
        orderId, operatorWallet, lenderWallet, total, payout,
        txBorrowerToOperator: tx1Txid, escrowId: escrow.id, error: err.message,
      });
      logger.error('[CRITICAL] Partial settlement: operator received funds but lender payout failed. Retry the same request to resume from tx2.', {
        orderId, escrowId: escrow.id, tx1Txid,
      });
      return res.status(500).json({
        message: 'Partial settlement: operator received funds but payout to lender failed. Retry this request (same orderId) to resume from tx2 without double-charging.',
        stage: 'operator_to_lender',
        orderId,
        escrowId: escrow.id,
        txBorrowerToOperator: { txid: tx1Txid },
        error: isProd ? 'Payout failed — see audit log for details' : err.message,
        retryable: true,
      });
    }

    // HELD → SETTLED: tx2 txid を原子的に記録
    EscrowRepository.updateIf(
      escrow.id,
      (e) => e.state === 'HELD',
      { state: 'SETTLED', txOperatorToLender: tx2Txid, updatedAt: new Date().toISOString() }
    );

    // PaymentRepository に paid レコードを書く。/orders/:id/start・/stop・/dispute の
    // hasPaidPayment ゲートは PaymentRepository を参照するため、このレコードがないと
    // btc-onchain で実際に資金を動かした後もサービス開始・終了・係争が一切できない
    // （資金喪失のまま注文が宙ぶらりになる）。btc-onchain は idempotent 設計のため
    // SETTLED 分の重複レコード作成を避けるため既存 paid レコードがある場合はスキップ。
    try {
      const existingPaid = (PaymentRepository.getByOrderId(orderId) || []).find(p => p.status === 'paid');
      if (!existingPaid) {
        PaymentRepository.create({
          orderId,
          userId: req.user.id,
          amount: Math.round(total * 1e8),
          status: 'paid',
          method: 'btc_onchain',
          txid: tx2Txid,
          paidAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      // 送金は完了しているため、PaymentRecord 書き込み失敗は致命的ではない（監査証跡は
      // EscrowRepository に残る）が警告する。管理者が手動で reconcile できるよう記録する。
      logger.warn(`[btc-onchain] PaymentRecord write failed for order ${orderId}: ${e.message}`);
    }

    return res.json({
      message: 'Payment processed with operator fee',
      orderId,
      totalPaid: total,
      payout,
      operatorFee: fee,
      txBorrowerToOperator: { txid: tx1Txid },
      txOperatorToLender: { txid: tx2Txid },
      escrowId: escrow.id,
    });
    }); // end withLock
  } catch (err) {
    logger.error('BTC on-chain payment error:', err);
    return res.status(500).json({ message: 'Payment processing failed', error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

module.exports = router;
