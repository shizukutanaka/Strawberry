// src/api/routes/payment/index.js - 決済関連APIルート
const express = require('express');
const router = express.Router();
const { asyncHandler, APIError, ErrorTypes } = require('../../../utils/error-handler');
const { validateMiddleware, schemas } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');
const { config } = require('../../../utils/config');

// コアサービスは共有のガード付きシングルトンから取得（未導入時は null）
const { lightning, requireService } = require('../../../core/services');
// ファイルベースJSONストレージリポジトリ
const PaymentRepository = require('../../../db/json/PaymentRepository');
const OrderRepository = require('../../../db/json/OrderRepository');
// 価格計算（時間単価解決・5分単価・JPY換算）の共通ユーティリティ
const { fetchRateInfo, computeOrderPricing } = require('../../../utils/order-pricing');
// 並行リクエストによる二重請求書発行を防ぐためのミューテックス
const { withLock } = require('../../../utils/async-lock');
const { appendAuditLog } = require('../../../utils/audit-log');

// インボイス作成 (管理者専用)
// 汎用インボイス発行は注文との紐付けなしにプラットフォームノードのインバウンド容量を消費するため
// 一般ユーザーに開放すると channel 容量 DoS の温床になる。order ベースの支払いは
// POST /payment/order/:id を使用すること。
router.post('/invoice',
  authenticateJWT,
  checkRole(['admin']),
  validateMiddleware(schemas.payment.createInvoice),
  asyncHandler(async (req, res) => {
    if (!requireService(lightning, res)) return;
    const { amount, description, expiry } = req.validatedBody;
    logger.info(`Creating invoice for ${amount} satoshis`);

    // 金額の範囲をチェック
    if (amount < config.lightning.minPaymentSatoshis) {
      throw new APIError(ErrorTypes.VALIDATION, `Amount too small. Minimum: ${config.lightning.minPaymentSatoshis} satoshis`, 400);
    }
    
    if (amount > config.lightning.maxPaymentSatoshis) {
      throw new APIError(ErrorTypes.VALIDATION, `Amount too large. Maximum: ${config.lightning.maxPaymentSatoshis} satoshis`, 400);
    }
    
    // インボイスを作成
    const invoice = await lightning.createInvoice({
      value: amount,
      memo: description,
      expiry: expiry || config.lightning.invoiceExpirySeconds
    });
    
    // インボイス情報をログに記録
    logger.info(`Invoice created: ${invoice.paymentRequest.substring(0, 20)}...`, {
      amount,
      userId: req.user.id,
      invoiceId: invoice.id
    });
    
    res.status(201).json({
      message: 'Invoice created',
      paymentRequest: invoice.paymentRequest,
      id: invoice.id,
      amount,
      description,
      expiresAt: invoice.expiresAt
    });
  })
);
// 旧 `POST /payments/pay`（admin が任意の BOLT11 を運営ノードから送金する）は
// 削除した（2026-09）。理由は 2 つ。
//   1. **送金なのに台帳へ payout の行を書かなかった。** プロバイダの出金申請と紐づかず、
//      送っても台帳残高が減らないため、同じ額をもう一度申請できた。btc-onchain と
//      同じ「台帳に映らない金」の穴で、削除し損ねていた
//   2. 記録の向きが逆だった。出ていく金を `status:'paid'` の PaymentRecord——本来は
//      借り手から**入ってきた**金の記録——として書いていた。しかも orderId が無いので
//      注文単位の突き合わせにも載らない
// 送金は `POST /payments/admin/payouts/:id/complete` 一本にした。出金申請の行が無ければ
// 送れないので、金が動けば必ず台帳に残る。注文の支払いは
// `POST /payments/order/:orderId`（Lightning / 手動の両方に対応）を使う。

// インボイス状態確認
router.get('/invoice/:id',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    if (!requireService(lightning, res)) return;
    const invoiceId = req.params.id;
    logger.info(`Checking invoice status: ${invoiceId}`);

    // 所有権チェック: インボイス(paymentHash)に紐づく決済レコードの所有者、
    // または管理者のみ閲覧可。任意の invoiceId 推測で他人の金額・入金状況を
    // 覗けないようにする（情報漏洩防止）。
    if (req.user.role !== 'admin') {
      const records = PaymentRepository.getByPaymentHash(invoiceId);
      const owns = Array.isArray(records) && records.some(p => p.userId === req.user.id);
      if (!owns) {
        throw new APIError(ErrorTypes.FORBIDDEN, 'You do not have permission to view this invoice', 403);
      }
    }

    // インボイス状態を確認
    const invoiceStatus = await lightning.checkInvoice(invoiceId);
    
    if (!invoiceStatus) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Invoice not found', 404);
    }
    
    res.json({
      id: invoiceId,
      status: invoiceStatus.settled ? 'paid' : 'pending',
      settledAt: invoiceStatus.settleDate,
      amount: invoiceStatus.value,
      expiresAt: invoiceStatus.expiresAt
    });
  })
);

// オーダーに対する支払い処理 (認証必須)
router.post('/order/:id',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    // べき等性チェックと請求書発行をミューテックス内で行う。
    // ミューテックスなしだと並行リクエストが両方とも「未払いなし」と判断し
    // 同一注文に二重の Lightning インボイスが発行される。
    return withLock(`payment:${orderId}`, async () => {
    const { paymentMethod } = req.body;
    logger.info(`Processing payment for order: ${orderId} (method: ${paymentMethod || 'lightning'})`);

    // 注文情報から金額自動取得（存在しない注文への 0 sats 請求書発行を防ぐ）
    const order = OrderRepository.getById(orderId);
    if (!order) {
      throw new APIError(ErrorTypes.NOT_FOUND, 'Order not found', 404);
    }
    if (order.userId !== req.user.id && req.user.role !== 'admin') {
      throw new APIError(ErrorTypes.FORBIDDEN, 'You do not have permission to pay for this order', 403);
    }
    // 決済可能なステータスのみ許可。cancelled/completed/disputed 注文に対して
    // Lightning インボイスを発行すると、資金受取後に対応する注文が存在せず
    // 返金経路も存在しない（資金喪失）。
    const PAYABLE_STATUSES = new Set(['pending', 'matched']);
    if (!PAYABLE_STATUSES.has(order.status)) {
      throw new APIError(
        ErrorTypes.VALIDATION,
        `Cannot create payment for order in '${order.status}' state. Only pending or matched orders accept payment.`,
        400
      );
    }
    // べき等性: 同一注文に対する未払い(pending)かつ未失効の決済が既に存在すれば、
    // 新たに請求書/決済レコードを作らず既存を返す。クライアントのタイムアウト再送で
    // 二重請求書発行・二重支払いが起きるのを防ぐ（決済系で最も避けたい事故）。
    const nowMs = Date.now();
    // べき等性チェック: orderId で検索（userId を問わない）。
    // 以前は p.userId === req.user.id で絞っていたため、管理者が同一注文で invoiceA を
    // 作成した後に借り手が invoiceB を作成できる二重インボイス問題があった。
    const existingPending = (PaymentRepository.getByOrderId(orderId) || []).find(p =>
      p.status === 'pending' &&
      (!p.invoiceExpiresAt || new Date(p.invoiceExpiresAt).getTime() > nowMs)
    );
    if (existingPending) {
      logger.info(`Returning existing pending payment for order ${orderId} (idempotent)`, {
        userId: req.user.id, orderId, paymentId: existingPending.id,
      });
      return res.json({
        status: 'pending',
        idempotent: true,
        paymentId: existingPending.id,
        orderId,
        amountSats: existingPending.amount,
        paymentMethod: existingPending.method,
        paymentRequest: existingPending.paymentRequest || undefined,
        invoiceId: existingPending.paymentHash || undefined,
        expiresAt: existingPending.invoiceExpiresAt || undefined,
        message: 'A pending payment already exists for this order. Reusing it instead of creating a duplicate.',
      });
    }
    const rateInfo = await fetchRateInfo();
    const { pricePerHour, pricePer5Min, durationMinutes, totalPrice, totalPriceJPY } =
      computeOrderPricing(order, rateInfo);
    // Lightning以外も選択可能
    if (paymentMethod && paymentMethod !== 'lightning') {
      // 現金/銀行振込など
      const paymentRecord = PaymentRepository.create({
        orderId,
        userId: order.userId,
        providerId: null,
        amount: totalPrice,
        status: 'pending', // 管理者承認後に'paid'へ
        paymentHash: null,
        paidAt: null,
        method: paymentMethod
      });
      logger.info('Manual payment for order recorded (pending admin approval)', {
        userId: req.user.id,
        orderId,
        amount: totalPrice,
        paymentMethod,
        paymentId: paymentRecord.id
      });
      res.json({
        status: 'pending',
        amountPaid: totalPrice,
        amountPaidJPY: totalPriceJPY,
        paymentMethod,
        paymentId: paymentRecord.id,
        pricePerHour,
        pricePer5Min,
        durationMinutes,
        message: 'Manual payment request recorded. Please complete the transfer and contact admin for approval.'
      });
      return;
    }
    // Lightning払い（デフォルト）— サービス未導入時は 503
    // 重要: ダミーtxidで「支払い済み」を捏造してはならない（資金喪失の原因）。
    // 実インボイスを発行し、ステータスは pending（ウォレットでの支払い完了を待つ）。
    if (!requireService(lightning, res)) return;
    const invoice = await lightning.createInvoice({
      value: totalPrice,
      memo: `GPU rental order ${orderId}`,
      expiry: config.lightning.invoiceExpirySeconds
    });
    if (!invoice || !invoice.paymentRequest) {
      throw new APIError(ErrorTypes.LIGHTNING_ERROR, 'Failed to create Lightning invoice', 502);
    }
    const expiresAt = new Date(Date.now() + (config.lightning.invoiceExpirySeconds || 3600) * 1000).toISOString();
    const paymentRecord = PaymentRepository.create({
      orderId,
      userId: order.userId,
      providerId: null,
      amount: totalPrice,
      status: 'pending',
      paymentHash: invoice.id,
      paymentRequest: invoice.paymentRequest,
      paidAt: null,
      method: 'lightning',
      invoiceExpiresAt: expiresAt
    });
    // モック LND が返す paymentRequest は「BOLT11 に見えるが支払えない文字列」。
    // それを 201 で返して「ウォレットで支払ってください」と案内すると、借り手は
    // 支払えない請求書を渡され、運営は Lightning が動いていると思い込む。
    // 支払えない場合はその事実をレスポンスに明記する。
    const payable = invoice.payable !== false;
    res.status(201).json({
      status: 'pending',
      paymentRequest: invoice.paymentRequest,
      invoiceId: invoice.id,
      amountSats: totalPrice,
      amountPaidJPY: totalPriceJPY,
      paymentMethod: 'lightning',
      paymentId: paymentRecord.id,
      pricePerHour,
      pricePer5Min,
      durationMinutes,
      expiresAt,
      payable,
      message: payable
        ? 'Lightning invoice created. Pay using your Lightning wallet.'
        : 'This server is running without a real Lightning node, so this invoice CANNOT be paid. '
          + 'Use another payment method, or configure LND.'
    });
    }); // end withLock
  })
);


// 支払いステータス確認（クライアントポーリング用）
router.get('/:id/status',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const payment = PaymentRepository.getById(req.params.id);
    if (!payment) throw new APIError(ErrorTypes.NOT_FOUND, 'Payment not found', 404);
    if (payment.userId !== req.user.id && req.user.role !== 'admin') {
      throw new APIError(ErrorTypes.FORBIDDEN, 'Access denied', 403);
    }
    res.json({
      id: payment.id,
      orderId: payment.orderId,
      status: payment.status,
      amount: payment.amount,
      method: payment.method,
      paidAt: payment.paidAt || null,
      invoiceExpiresAt: payment.invoiceExpiresAt || null
    });
  })
);

// ライトニングノード情報取得
router.get('/node-info',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    if (!requireService(lightning, res)) return;
    logger.info('Fetching Lightning node info');

    // ノード情報を取得
    const nodeInfo = await lightning.getNodeInfo();
    
    // 機密情報をマスク
    if (nodeInfo.uris) {
      nodeInfo.uris = nodeInfo.uris.map(uri => {
        const parts = uri.split('@');
        if (parts.length > 1) {
          return `${parts[0].substring(0, 10)}...@${parts[1]}`;
        }
        return uri;
      });
    }
    
    res.json(nodeInfo);
  })
);

// チャネル一覧取得
router.get('/channels',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    if (!requireService(lightning, res)) return;
    logger.info('Fetching Lightning channels');

    // チャネル一覧を取得
    const channels = await lightning.listChannels();
    
    // 機密情報をマスク
    const sanitizedChannels = channels.map(channel => ({
      id: channel.channelId,
      active: channel.active,
      remote_pubkey: `${channel.remotePubkey.substring(0, 10)}...`,
      capacity: channel.capacity,
      local_balance: channel.localBalance,
      remote_balance: channel.remoteBalance,
      total_satoshis_sent: channel.totalSatoshisSent,
      total_satoshis_received: channel.totalSatoshisReceived,
      num_updates: channel.numUpdates
    }));
    
    res.json({
      total: sanitizedChannels.length,
      channels: sanitizedChannels
    });
  })
);

// 支払い履歴取得（ページネーション対応: ?limit=N&offset=M、新しい順）
router.get('/history',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    logger.info('Fetching payment history');

    const raw = PaymentRepository.getByUserId(req.user.id) || [];
    // 新しい順
    const sorted = [...raw].sort((a, b) =>
      (b.paidAt || b.createdAt || '').localeCompare(a.paidAt || a.createdAt || ''));
    const total = sorted.length;
    const limitRaw = parseInt(req.query.limit, 10);
    const offsetRaw = parseInt(req.query.offset, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const page = sorted.slice(offset, offset + limit);
    const payments = page.map(payment => ({
      id: payment.id,
      orderId: payment.orderId,
      amount: payment.amount,
      status: payment.status,
      paymentHash: payment.paymentHash,
      paidAt: payment.paidAt
    }));
    res.json({ total, limit, offset, payments });
  })
);

// 旧 `POST /payment/btc`（btc-onchain）は削除した（2026-09）。理由は 3 つで、いずれも
// 「オンチェーン BTC 決済」という要件自体が成立していなかったことに帰着する。
//   1. オンチェーンではなかった。sendBTC は Lightning API を呼ぶだけだった
//   2. 支払い時点でプロバイダへ全額を送っていた。GPU が起動する前である。従量按分・
//      SLA ペナルティ・係争返金・Spot 中断按分をすべて迂回し、借り手が返金裁定を
//      得ても運営の手元に原資が無かった
//   3. その送金は台帳に行を書かないため、収益台帳へ**二重に**計上されていた
//      （プロバイダは送金と台帳残高の両方を受け取れた）。しかも突き合わせは
//      支払記録と台帳しか見ないので healthy を返し続けた
// 決済は Lightning 経路（POST /payments/order/:id）に一本化した。

// 管理者向け：承認待ちの手動決済（銀行振込等）一覧。
// GET /payments/history は req.user.id のみに絞られるため（本人の決済履歴専用）、
// 管理者が全ユーザー横断で「今どの決済が承認待ちか」を確認する経路が存在しなかった
// （手動承認 UI を作るにはこの一覧が前提として必須）。
router.get('/admin/pending',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const UserRepository = require('../../../db/json/UserRepository');
    const all = PaymentRepository.getAll() || [];
    const pending = all.filter(p => p.status === 'pending' && p.method !== 'lightning');
    const sorted = [...pending].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const enriched = sorted.map(p => {
      const order = p.orderId ? OrderRepository.getById(p.orderId) : null;
      const renter = p.userId ? UserRepository.getById(p.userId) : null;
      return {
        id: p.id,
        orderId: p.orderId,
        amount: p.amount,
        method: p.method,
        createdAt: p.createdAt || null,
        orderStatus: order ? order.status : null,
        renterUsername: renter ? renter.username : null,
      };
    });
    res.json({ total: enriched.length, payments: enriched });
  })
);

// 管理者による手動支払い承認API
router.post('/manual/approve/:id',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const paymentId = req.params.id;
    // withLock prevents TOCTOU between the order-status guard and the updateIf CAS:
    // without it, two admins could both pass the order-status check (order still 'pending')
    // and then both call updateIf, with the second succeeding if the first hasn't committed yet.
    await withLock(`payment:${paymentId}`, async () => {
      const payment = PaymentRepository.getById(paymentId);
      if (!payment) {
        throw new APIError(ErrorTypes.NOT_FOUND, 'Payment not found', 404);
      }
      if (payment.method === 'lightning') {
        throw new APIError(ErrorTypes.VALIDATION, 'Lightning payments cannot be manually approved', 400);
      }
      // Guard: approving a payment on a cancelled/completed order creates an orphaned
      // paid record that can confuse reconciliation and future hasPaidPayment checks.
      // Only approve if the associated order is in a payable state.
      if (payment.orderId) {
        const order = OrderRepository.getById(payment.orderId);
        if (order && !['pending', 'matched'].includes(order.status)) {
          throw new APIError(
            ErrorTypes.VALIDATION,
            `Cannot approve payment: associated order is in '${order.status}' state (only pending/matched orders accept payment approval)`,
            409
          );
        }
      }
      // Atomic compare-and-swap: check status and write in one synchronous section to
      // prevent two concurrent admin approvals from both seeing status!=='paid' and
      // double-approving the same payment.
      const result = PaymentRepository.updateIf(
        paymentId,
        p => p.status !== 'paid' && p.method !== 'lightning',
        { status: 'paid', paidAt: new Date().toISOString() }
      );
      if (!result.ok) {
        const cur = result.current;
        if (cur && cur.status === 'paid') {
          throw new APIError(ErrorTypes.VALIDATION, 'Payment already marked as paid', 400);
        }
        throw new APIError(ErrorTypes.VALIDATION, 'Payment cannot be approved in its current state', 400);
      }
      const updated = result.row;
      res.json({
        message: 'Manual payment approved',
        paymentId,
        status: updated.status,
        paidAt: updated.paidAt
      });
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// 収益台帳と出金（src/payments/payout-ledger.js）
//
// ここまでの決済 API は「借り手 → 運営」の受取だけを扱っており、受け取った sats が
// プロバイダへ渡る経路はコード上のどこにも存在しなかった。以下がその経路にあたる。
// ─────────────────────────────────────────────────────────────────────────────
const payoutLedger = require('../../../payments/payout-ledger');

// 自分の残高と仕訳明細（プロバイダの稼ぎ・借り手への返金の両方がここに載る）
router.get('/earnings',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const limitRaw = parseInt(req.query.limit, 10);
    const offsetRaw = parseInt(req.query.offset, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const balance = payoutLedger.balanceFor(req.user.id);
    const { total, entries } = payoutLedger.listEntries(req.user.id, { limit, offset });
    res.json({
      balance,
      minimumPayoutSats: payoutLedger.MIN_PAYOUT_SATS,
      total, limit, offset,
      entries,
    });
  })
);

// 出金申請。送金先は body ではなくサーバ保持の user.payoutAddress のみを使う
// （body から取ると、トークンを盗んだ攻撃者が送金先だけ差し替えて資金を抜ける）。
router.post('/payouts',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const { amountSats } = req.body || {};
    // 同一ユーザーの並行申請が両方とも「残高十分」と判定して二重出金になるのを防ぐ。
    const result = await withLock(`payout:${req.user.id}`, async () =>
      payoutLedger.requestPayout({ userId: req.user.id, amountSats })
    );
    if (!result.ok) {
      const status = result.reason === 'user_not_found' ? 404 : 400;
      return res.status(status).json({ error: result.reason, ...result });
    }
    appendAuditLog('payout_requested', {
      payoutId: result.payout.id, amountSats: result.payout.amountSats,
    }, req.user.id);
    res.status(201).json({
      message: 'Payout requested. An operator will send the funds and record the transaction id.',
      payout: result.payout,
      balance: result.balance,
    });
  })
);

// 自分の出金申請一覧
router.get('/payouts',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const { entries } = payoutLedger.listEntries(req.user.id, { limit: 200 });
    res.json({ payouts: entries.filter((e) => e.kind === 'payout') });
  })
);

// 運営: 送金待ちの出金申請一覧
router.get('/admin/payouts',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const UserRepository = require('../../../db/json/UserRepository');
    const pending = payoutLedger.pendingPayouts().map((p) => {
      const user = p.userId ? UserRepository.getById(p.userId) : null;
      return { ...p, username: user ? user.username : null };
    });
    res.json({ total: pending.length, payouts: pending });
  })
);

// 運営: 実際に送金した事実を記録する（txid 必須）。
// **このシステムは送金そのものを自動実行しない。** ノードを持たずに「送金済み」と
// 記録する経路を作ると、台帳が現実と乖離したまま帳尻だけ合ってしまう。
// **このコードベースで唯一、外部へ資金が出ていく経路**（`lightning.payInvoice`）。
// 出金申請の行に束縛されているので、金が動けば必ず台帳に残る。2 つの使い方がある:
//   { txid }          … 運営が自分のノード/ウォレットから送り、証跡だけ記録する（従来どおり）
//   { paymentRequest } … その BOLT11 をこのサーバが LND 経由で払い、実 payment hash を記録する
// 後者は「送金したのに台帳を更新し忘れる」窓を無くす。前者を残すのは、オンチェーン送金や
// LND を持たない運用が実在するため。どちらも申請 → 送金 → 記録が 1 つのロックの中で完結する。
router.post('/admin/payouts/:id/complete',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const { txid, paymentRequest, maxFeePercent } = req.body || {};
    if (txid && paymentRequest) {
      return res.status(400).json({ error: 'provide either txid (already sent) or paymentRequest (send now), not both' });
    }
    const result = await withLock(`payout-entry:${req.params.id}`, async () => {
      if (!paymentRequest) {
        return payoutLedger.completePayout(req.params.id, { txid, byUserId: req.user.id });
      }
      // ── 送金してから記録する経路 ───────────────────────────────────────────
      // 送金の前に必ず申請の実在と状態を確かめる。存在しない/既に払った申請に対して
      // 送ってしまうと、その送金はどの台帳行にも紐づかない（=見えない金になる）。
      if (!requireService(lightning, res)) return null;
      if (typeof paymentRequest !== 'string' || !/^ln(bc|tb|bcrt)[0-9a-z]+$/i.test(paymentRequest)) {
        return { ok: false, reason: 'invalid_payment_request' };
      }
      const pending = payoutLedger.pendingPayouts().find((p) => p.id === req.params.id);
      if (!pending) return { ok: false, reason: 'not_found_or_not_pending' };

      // インボイス額が申請額を超えていないこと。超過分は台帳のどこにも計上されない
      // 支払いになるため、ここで止める。
      let invoiceSats;
      try {
        const decoded = await lightning.decodePaymentRequest(paymentRequest);
        invoiceSats = Number(decoded && (decoded.num_satoshis || decoded.numSatoshis));
      } catch (e) {
        return { ok: false, reason: 'undecodable_payment_request', detail: e.message };
      }
      if (!Number.isFinite(invoiceSats) || invoiceSats <= 0) {
        return { ok: false, reason: 'invoice_has_no_amount' };
      }
      if (invoiceSats > pending.amountSats) {
        return { ok: false, reason: 'invoice_exceeds_payout', invoiceSats, payoutSats: pending.amountSats };
      }

      let sent;
      try {
        sent = await lightning.payInvoice(paymentRequest, invoiceSats, maxFeePercent);
      } catch (e) {
        // 送金は成立していない。申請は requested のまま残るので再試行できる。
        appendAuditLog('payout_send_failed', { payoutId: req.params.id, invoiceSats, error: e.message }, req.user.id);
        return { ok: false, reason: 'send_failed', detail: e.message };
      }
      const hash = sent && (sent.paymentHash || sent.payment_hash);
      if (!hash) {
        // 送金が成立したのに証跡が取れない最悪のケース。台帳を勝手に確定させず、
        // 監査ログに残して人間が照合できるようにする（黙って paid にすると、
        // 実際に送ったかどうかを誰も検証できなくなる）。
        appendAuditLog('payout_sent_without_txid', { payoutId: req.params.id, invoiceSats }, req.user.id);
        return { ok: false, reason: 'sent_but_no_payment_hash' };
      }
      return payoutLedger.completePayout(req.params.id, { txid: hash, byUserId: req.user.id });
    });
    if (result === null) return; // requireService が既に 503 を返している
    if (!result.ok) {
      const status = result.reason === 'not_found' || result.reason === 'not_found_or_not_pending' ? 404
        : result.reason === 'send_failed' || result.reason === 'sent_but_no_payment_hash' ? 502 : 400;
      return res.status(status).json({ error: result.reason, current: result.current, detail: result.detail });
    }
    appendAuditLog('payout_completed', {
      payoutId: result.payout.id, amountSats: result.payout.amountSats, txid: result.payout.txid,
      sentByServer: Boolean(paymentRequest),
    }, req.user.id);
    res.json({ message: 'Payout marked as sent', payout: result.payout });
  })
);

// 運営: 出金申請の却下（残高は自動的に戻る＝ reserved から外れる）
router.post('/admin/payouts/:id/reject',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const { reason } = req.body || {};
    const result = await withLock(`payout-entry:${req.params.id}`, async () =>
      payoutLedger.rejectPayout(req.params.id, { reason, byUserId: req.user.id })
    );
    if (!result.ok) {
      return res.status(result.reason === 'not_found' ? 404 : 400).json({ error: result.reason, current: result.current });
    }
    appendAuditLog('payout_rejected', { payoutId: result.payout.id, reason: reason || null }, req.user.id);
    res.json({ message: 'Payout rejected', payout: result.payout });
  })
);

// 運営: 帳簿の突き合わせ。「今いくら預かっていて、いくら払う義務があるか」と、
// 4 つの不変条件を返す（src/payments/reconciliation.js）: 保存則・取りこぼしゼロ・
// 出所のない計上ゼロ・裏付けのない出金ゼロ。
// カストディアル運用では他人の金を預かるため、これを機械的に確認できることが前提。
router.get('/admin/reconciliation',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const report = require('../../../payments/reconciliation').reconcile();
    const healthy = report.invariants.conservationHolds
      && report.invariants.noUncreditedTerminalOrders
      && report.invariants.noOrphanCredits
      && report.invariants.noUnbackedPayouts;
    if (!healthy) {
      // 帳簿の不一致は運用者が必ず見るべき事象なので監査ログにも残す。
      appendAuditLog('ledger_reconciliation_mismatch', {
        discrepancies: report.discrepancies.length,
        uncreditedTerminal: report.uncreditedTerminal.length,
        orphanCredits: report.orphanCredits.length,
        unbackedPayouts: report.unbackedPayouts.length,
      }, req.user.id);
    }
    res.json({ healthy, ...report });
  })
);

// 運営: 収益計上を即時実行する（定期ジョブを待たずに確認するため）
router.post('/admin/earnings/sweep',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const summary = require('../../../payments/earnings-sweeper').runOnce();
    res.json(summary);
  })
);

module.exports = router;
