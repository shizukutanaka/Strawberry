// 支払い・受取API（BTC差益自動控除）
const express = require('express');
const router = express.Router();
// 意図的に btc-payment の送金関数（sendBTC / getOperatorWallet 等）を import しない。
// 本ルートは fail-closed 化されており資金を一切動かさない。スコープに入れないことで
// 「うっかり再配線して資金流出を復活させる」事故を構文レベルで防ぐ
// （理由の詳細はハンドラ内の FAIL-CLOSED コメントを参照）。
const { logger } = require('../../../utils/logger');
const { withLock } = require('../../../utils/async-lock');
const { authenticateJWT } = require('../../middleware/security');
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
router.post('/', authenticateJWT, async (req, res) => {
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
    // 注文状態ゲート: cancelled / completed / disputed / active 注文への支払いを拒否。
    // active を含めない理由: active な注文はすでに /start が完了しており、/start は
    // hasPaidPayment を確認するため active になった時点で支払いは完了しているはずである。
    // active 注文に対して再度 POST /payment/btc を許可すると、Lightning で支払い済みの
    // 注文に btc_onchain エスクローが新たに作成されて二重課金になる可能性がある。
    // TX1失敗後の再試行（idempotent resume）は HELD エスクローで保護されており、
    // active ゲート除去後も HELD → SETTLED の resume は pending/matched 状態のうちに完了する。
    const ALLOWED_BTC_PAYMENT_STATUSES = new Set(['pending', 'matched']);
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
    // ── エスクロー冪等性チェック ───────────────────────────────────────────────
    // fail-closed 化以前に SETTLED まで到達したエスクロー（レガシーデータ）は、
    // 資金を動かさずにキャッシュ済み結果を返すため引き続き参照する。
    const EscrowRepository = require('../../../db/json/EscrowRepository');
    const existingEscrows = EscrowRepository.getByOrderId(orderId);
    // 完了・進行中の最新エスクロー（CANCELED は無視）
    const escrow = existingEscrows.find(e => e.state !== 'CANCELED') || null;

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

    // ── FAIL-CLOSED: この経路は資金を動かしてはならない ──────────────────────
    // このルートの前提「TX1: 借り手 → 運営」は原理的に成立しない。
    //
    // Lightning には「相手の同意なく一方的に資金を引き出す」真の pull payment が存在
    // しない。LNURL-withdraw は *資金源が事前に発行した引き出し許可* に対して受取側の
    // ウォレットが能動的に要求する仕組みであり、BOLT12 の invoice_request も同様に
    // 開始側の操作を必要とする。つまりサーバーが API 呼び出しだけで借り手の財布から
    // 徴収する手段は存在しない。
    //
    // 実装も実際そうなっていた: sendBTC(from, to, amount) は from を無視して
    // sendLightningPayment(to, ...) を呼ぶだけで（utils/btc-payment.js）、その実体は
    // OpenNode の POST /v2/withdrawals ／ LNbits の {out:true} ＝ 送金専用 API
    // （utils/lightning-api.js）。したがって TX1 は「借り手から徴収」ではなく
    // 「運営が自己資金を運営アドレスへ払い出す」動作になり、続く TX2 でさらに貸し手へ
    // 払い出していた。結果として借り手が 1sat も支払わないままプロバイダーへ送金される
    // （実損）。しかも本ルートは管理者限定ではなく注文の借り手自身が実行できた。
    //
    // 徴収は「借り手がインボイスを支払う」形でしか実現できず、それは既に正しく動作して
    // いる Lightning 経路（POST /payments/order/:id ＋ invoice-poller）が担っている。
    // よってここは修正して徴収させるのではなく、資金を一切動かさず明示的に失敗させる
    // （本プロジェクトの「正直なUI原則」＝偽の成功を返さない）。
    //
    // 配置意図: 既存の検証ガード（所有権・注文状態・二重支払い・payoutAddress 必須・
    // 自己取引禁止）と、レガシー SETTLED エスクローの冪等キャッシュ返却（資金を動かさない）
    // はすべて通過させたうえで、新規エスクロー作成と送金の直前で止める。これにより
    // PENDING エスクローでデータを汚さず、既存の防御も温存される。
    return res.status(501).json({
      message: 'BTC on-chain payment is not available: this route cannot collect funds from the renter '
        + '(Lightning payments require the payer to initiate; a server API call cannot debit a renter wallet). '
        + 'No funds were moved. Use the Lightning invoice flow instead: POST /api/v1/payments/order/:id',
      code: 'BTC_ONCHAIN_NOT_IMPLEMENTED',
      useInstead: 'POST /api/v1/payments/order/:id',
    });
    }); // end withLock
  } catch (err) {
    logger.error('BTC on-chain payment error:', err);
    return res.status(500).json({ message: 'Payment processing failed', error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

module.exports = router;
