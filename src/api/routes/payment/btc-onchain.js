// 支払い・受取API（BTC差益自動控除）
const express = require('express');
const router = express.Router();
const { FEE_RATE, calcTotalWithFee, calcFee, calcPayout, sendBTC, getOperatorWallet } = require('../../utils/btc-payment');
const { appendAuditLog } = require('../../../utils/audit-log');
const { logger } = require('../../../utils/logger');

/**
 * POST /payment
 * body: { orderId, lenderWallet, borrowerWallet, priceBTC }
 * フロー: 借り手→運営（1.5%上乗せ）、運営→貸し手（純額）、利益は運営に残る
 */
router.post('/', async (req, res) => {
  try {
    const { orderId, lenderWallet: bodyLenderWallet, borrowerWallet } = req.body;
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

    // 貸し手(プロバイダ)への送金先(lenderWallet)を決定する。
    // 借り手(req.user)がボディで任意の lenderWallet を指定できると、プロバイダへの payout を
    // 別アドレスへ流す/握りつぶす詐称・妨害が可能になる。よってプロバイダ本人が登録した
    // payoutAddress を「正」とし、登録があればボディ値を無視する。
    const UserRepository = require('../../../db/json/UserRepository');
    const provider = order.providerId ? UserRepository.getById(order.providerId) : null;
    let lenderWallet = (provider && provider.payoutAddress) ? provider.payoutAddress : bodyLenderWallet;
    if (!lenderWallet) {
      return res.status(400).json({
        message: 'No payout address available for this order. The GPU provider must register a payoutAddress (PUT /users/me) before payouts can be sent.'
      });
    }
    if (typeof lenderWallet !== 'string' || lenderWallet.length < 10 || lenderWallet.length > 500) {
      return res.status(400).json({ message: 'Invalid lenderWallet format' });
    }
    // 登録済み payoutAddress が無くボディ値にフォールバックする場合、借り手が payout を
    // 自分(=借り手ウォレット)へ流す self-dealing を拒否する。プロバイダが本来受け取る送金を
    // 借り手が奪える穴を塞ぐ（登録アドレスがあれば上書き済みのためこの経路には入らない）。
    if (!(provider && provider.payoutAddress) && lenderWallet === borrowerWallet) {
      return res.status(400).json({
        message: 'lenderWallet must differ from borrowerWallet. Ask the provider to register a payoutAddress for a verified payout.'
      });
    }
    // order.totalPrice（サトシ）→ BTC 換算（1 BTC = 1e8 sat）
    // 注文作成時にロックされた pricePerHour・durationMinutes から算出済み。
    if (!order.totalPrice || order.totalPrice <= 0) {
      return res.status(422).json({ message: 'Order has no valid total price; cannot process payment' });
    }
    const priceBTC = order.totalPrice / 1e8;
    // 借り手が支払う総額
    const total = calcTotalWithFee(priceBTC);
    // 運営利益
    const fee = calcFee(priceBTC);
    // 貸し手への送金額
    const payout = calcPayout(priceBTC);

    // 利益送金先アドレスを選択
    const operatorWallet = getOperatorWallet();

    // 1. 借り手→運営（失敗時は資金未移動。安全に失敗を返す）
    const isProd = process.env.NODE_ENV === 'production';
    let tx1;
    try {
      tx1 = await sendBTC(borrowerWallet, operatorWallet, total);
    } catch (err) {
      return res.status(502).json({
        message: 'Payment failed before any funds were moved',
        stage: 'borrower_to_operator',
        error: isProd ? 'Lightning payment failed' : err.message
      });
    }

    // 2. 運営→貸し手（tx1 成立後にここが失敗すると資金が運営に滞留する＝部分決済）
    let tx2;
    try {
      tx2 = await sendBTC(operatorWallet, lenderWallet, payout);
    } catch (err) {
      // 重大: 借り手→運営は成立済みだが貸し手への送金が失敗。手動照合が必要。
      appendAuditLog('payment_partial_settlement', {
        orderId, operatorWallet, lenderWallet, total, payout,
        txBorrowerToOperator: tx1, error: err.message
      });
      logger.error('[CRITICAL] Partial settlement: operator received funds but lender payout failed. Manual reconciliation required.', { orderId, txid: tx1 && tx1.txid });
      return res.status(500).json({
        message: 'Partial settlement: operator received funds but payout to lender failed. Manual reconciliation required.',
        stage: 'operator_to_lender',
        orderId,
        txBorrowerToOperator: tx1,
        error: isProd ? 'Payout failed — see audit log for details' : err.message
      });
    }

    // 利益記録（DBや監査ログに記録推奨）
    // ここではレスポンスに含める
    return res.json({
      message: 'Payment processed with operator fee',
      orderId,
      totalPaid: total,
      payout,
      operatorFee: fee,
      txBorrowerToOperator: tx1,
      txOperatorToLender: tx2
    });
  } catch (err) {
    logger.error('BTC on-chain payment error:', err);
    return res.status(500).json({ message: 'Payment processing failed', error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

module.exports = router;
