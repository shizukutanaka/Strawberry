// 支払い・受取API（BTC差益自動控除）
const express = require('express');
const router = express.Router();
const { FEE_RATE, calcTotalWithFee, calcFee, calcPayout, sendBTC } = require('../utils/btc-payment');

// 運営ウォレットアドレス（複数管理・分散送金）
const { getOperatorWallet } = require('../utils/btc-payment');

/**
 * POST /payment
 * body: { orderId, lenderWallet, borrowerWallet, priceBTC }
 * フロー: 借り手→運営（1.5%上乗せ）、運営→貸し手（純額）、利益は運営に残る
 */
router.post('/', async (req, res) => {
  try {
    const { orderId, lenderWallet, borrowerWallet, priceBTC } = req.body;
    if (!orderId || !lenderWallet || !borrowerWallet || !priceBTC) {
      return res.status(400).json({ message: 'orderId, lenderWallet, borrowerWallet, priceBTC are required' });
    }
    // 借り手が支払う総額
    const total = calcTotalWithFee(priceBTC);
    // 運営利益
    const fee = calcFee(priceBTC);
    // 貸し手への送金額
    const payout = calcPayout(priceBTC);

    // 利益送金先アドレスを選択
    const operatorWallet = getOperatorWallet();

    // 1. 借り手→運営（失敗時は資金未移動。安全に失敗を返す）
    let tx1;
    try {
      tx1 = await sendBTC(borrowerWallet, operatorWallet, total);
    } catch (err) {
      return res.status(502).json({
        message: 'Payment failed before any funds were moved',
        stage: 'borrower_to_operator',
        error: err.message
      });
    }

    // 2. 運営→貸し手（tx1 成立後にここが失敗すると資金が運営に滞留する＝部分決済）
    let tx2;
    try {
      tx2 = await sendBTC(operatorWallet, lenderWallet, payout);
    } catch (err) {
      // 重大: 借り手→運営は成立済みだが貸し手への送金が失敗。手動照合が必要。
      const { appendAuditLog } = require('../../utils/audit-log');
      appendAuditLog('payment_partial_settlement', {
        orderId, operatorWallet, lenderWallet, total, payout,
        txBorrowerToOperator: tx1, error: err.message
      });
      console.error('[CRITICAL] Partial settlement: operator received funds but lender payout failed. Manual reconciliation required.', { orderId, tx1: tx1 && tx1.txid });
      return res.status(500).json({
        message: 'Partial settlement: operator received funds but payout to lender failed. Manual reconciliation required.',
        stage: 'operator_to_lender',
        orderId,
        txBorrowerToOperator: tx1,
        error: err.message
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
    console.error(err);
    return res.status(500).json({ message: 'Payment processing failed', error: err.message });
  }
});

module.exports = router;
