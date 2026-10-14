// src/core/invoice-poller.js
// Polls pending Lightning invoices and transitions payment/order state when settled.
// Design: single setInterval loop, re-entrant-safe (lock prevents overlapping runs).
const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');
const PaymentRepository = require('../db/json/PaymentRepository');
const OrderRepository = require('../db/json/OrderRepository');
const { registerDaemon, unregisterDaemon } = require('../utils/daemon-registry');
const { resolveDataDir } = require('../db/json/data-dir');
const promotions = require('../utils/promotions');
const settlement = require('./invoice-settlement');

const POLL_INTERVAL_MS = 15_000; // check every 15 s
const PAYMENTS_FILE = path.join(resolveDataDir(), 'payments.json');

let _timer = null;
let _running = false;
let _lightning = null; // set via start()
let _lastStamp = null;   // `${mtimeMs}:${size}` — 前回スキャン時のファイル指紋
let _lastPending = null; // 前回スキャンの pending 数（null=未走査）
let _lastUnapplied = null; // 前回スキャンの paid 未適用 featured 支払い数

function _fileStamp() {
  try {
    const s = fs.statSync(PAYMENTS_FILE);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null; // stat 失敗時はゲートを使わず従来通り読む
  }
}

async function pollOnce() {
  if (!_lightning || _running) return;
  _running = true;
  try {
    // stat ゲート: ファイルが前回スキャンから不変かつ前回 pending 0 なら、
    // pending は依然 0 が確定するので全量パースをスキップ。
    // （pending >0 のときは各インボイスの外部決済状態を毎回問い合わせるため
    // この経路は使わない — 静寂時の I/O をゼロにするための早期 return）
    const stamp = _fileStamp();
    if (stamp !== null && stamp === _lastStamp && _lastPending === 0 && _lastUnapplied === 0) return;
    const allPayments = PaymentRepository.getAll();
    const pending = allPayments.filter(
      (p) => p.method === 'lightning' && p.status === 'pending' && p.paymentHash
    );
    _lastStamp = stamp;
    _lastPending = pending.length;
    // featured 購入の和解: paid だが未適用（featuredActivatedAt なし）の
    // featured_listing 支払いを毎 tick 回収する。pending が 0 でも走らせる —
    // GPU 書込み一時失敗で滞留した paid を再試行する唯一の巡回点。
    // _lastUnapplied も stat ゲートに含め、滞留中はファイル不変でも次 tick が回収する。
    try {
      _lastUnapplied = promotions.reconcilePaidPromotions(allPayments);
    } catch (e) {
      _lastUnapplied = 1; // 失敗時はゲートを開いたままにし次 tick で再試行
      logger.warn(`promotion reconcile failed: ${e.message}`);
    }
    if (pending.length === 0) return;

    // ループ内の注文/支払い参照は tick 冒頭のスナップショットで解決する —
    // インボイスごとの getById/getByOrderId は同一 JSON の全量パース再実行だった。
    // 最終的な状態遷移は updateIf の CAS が原子的に再検証するため、参照側の
    // 鮮度が tick 開始時点でも安全性は変わらない。
    const orderById = new Map(OrderRepository.getAll().map(o => [o.id, o]));
    const paymentsByOrder = new Map();
    for (const p of allPayments) {
      if (!p.orderId) continue;
      const list = paymentsByOrder.get(p.orderId) || [];
      list.push(p);
      paymentsByOrder.set(p.orderId, list);
    }

    // per-invoice の遷移 stage は invoice-settlement へ分離（細分化）—
    // pollOnce は走査・スナップショット・dispatch のみを担う。
    for (const payment of pending) {
      try {
        const invoiceStatus = await _lightning.checkInvoice(payment.paymentHash);

        if (invoiceStatus && invoiceStatus.settled) {
          settlement.applySettledPayment(payment, invoiceStatus, { orderById, paymentsByOrder });
        } else if (settlement.isInvoiceExpired(payment)) {
          settlement.applyExpiredPayment(payment);
        }
      } catch (err) {
        // Per-invoice errors should not crash the whole poll cycle
        logger.warn(`invoice-poller: error checking paymentId=${payment.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`invoice-poller: unexpected error: ${err.message}`);
  } finally {
    _running = false;
  }
}

function start(lightningService) {
  if (_timer) return; // already running
  if (!lightningService) {
    logger.warn('invoice-poller: Lightning service unavailable — poller not started');
    return;
  }
  _lightning = lightningService;
  // NODE_ENV==='test': サービス参照のバインドと初回 pollOnce() は行うが、
  // 周期タイマーは張らない。Jest はテストファイルごとにモジュールレジストリを
  // 分離するため、server.js を require する各スイートがそれぞれ 15 秒周期の
  // タイマーを生成し、実タイマーは同一プロセスに残り続けて 100 スイート超で
  // イベントループを圧迫する（後続スイートの supertest が 30 秒タイムアウト）。
  // pollOnce() を直接呼ぶテストは _lightning が要るのでバインドは残す。
  if (process.env.NODE_ENV !== 'test') {
    _timer = setInterval(pollOnce, POLL_INTERVAL_MS);
    // unref so the timer does not prevent process exit
    if (_timer.unref) _timer.unref();
    registerDaemon('invoice-poller', stop);
    logger.info(`invoice-poller: started (interval=${POLL_INTERVAL_MS}ms)`);
  }
  // run immediately on start
  pollOnce();
}

function stop() {
  unregisterDaemon('invoice-poller');
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _lightning = null;
  _running = false;
  _lastStamp = null;
  _lastPending = null;
}

module.exports = { start, stop, pollOnce };
