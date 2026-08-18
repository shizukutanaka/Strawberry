// src/payments/earnings-sweeper.js
// 完了した注文をまとめて台帳に計上する定期ジョブ。
//
// なぜ完了処理の各所にフックを刺さず、掃き出し（sweep）にしたか:
// 注文が completed になる経路は現時点で 5 つある（/stop、SLA ハートビート途絶、
// 期限切れ、中断確定、係争解決）。それぞれに「収益を計上する」呼び出しを足すと、
// 6 つ目の経路が将来足された瞬間に**プロバイダが黙って無給になる**。
// 計上は orderId で冪等なので、状態を後から観測して埋める方が安全で、
// 既に完了している過去の注文も自動的に拾える。
//
// 設計は src/core/invoice-poller.js / src/security/anchor-scheduler.js と同型:
// setInterval + 再入ロック + unref。
const { logger } = require('../utils/logger');
const { appendAuditLog } = require('../utils/audit-log');
const payoutLedger = require('./payout-ledger');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 分
// 1 サイクルで見る注文の上限。JSON 層を長時間ロックしないための上限で、
// 積み残しは次サイクルが拾う（冪等なので取りこぼしにならない）。
const MAX_PER_CYCLE = 200;

let _timer = null;
let _running = false;

function intervalMs() {
  const v = Number(process.env.EARNINGS_SWEEP_INTERVAL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_INTERVAL_MS;
}

/**
 * 1 サイクル実行する。
 * @returns {{credited:number, skipped:number, errors:number, entries:object[]}}
 */
function runOnce(deps = {}) {
  if (_running) return { credited: 0, skipped: 0, errors: 0, entries: [], skippedCycle: true };
  _running = true;
  try {
    const OrderRepo = deps.OrderRepository || require('../db/json/OrderRepository');
    const orders = (OrderRepo.getAll() || []).filter(
      (o) => o && payoutLedger.CREDITABLE_ORDER_STATUSES.has(o.status)
    );
    let credited = 0, skipped = 0, errors = 0;
    const entries = [];
    for (const order of orders.slice(0, MAX_PER_CYCLE)) {
      try {
        const result = payoutLedger.creditOrder(order, deps);
        if (!result.credited) { skipped += 1; continue; }
        credited += 1;
        entries.push(...result.entries);
        appendAuditLog('order_earnings_credited', {
          orderId: order.id,
          providerId: order.providerId || null,
          providerPayoutSats: result.settlement.providerPayoutSats,
          renterRefundSats: result.settlement.renterRefundSats,
          operatorFeeSats: result.settlement.operatorFeeSats,
          source: result.settlement.source,
        });
      } catch (e) {
        errors += 1;
        logger.warn(`earnings-sweeper: failed to credit order ${order.id}: ${e.message}`);
      }
    }
    if (credited > 0) {
      logger.info(`earnings-sweeper: credited ${credited} order(s) to the ledger (skipped=${skipped}, errors=${errors})`);
    }
    return { credited, skipped, errors, entries };
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer) return;
  _timer = setInterval(() => {
    try { runOnce(); } catch (e) { logger.warn(`earnings-sweeper: cycle failed: ${e.message}`); }
  }, intervalMs());
  if (_timer.unref) _timer.unref();
  logger.info(`earnings-sweeper: started (interval=${intervalMs()}ms)`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, runOnce, intervalMs, DEFAULT_INTERVAL_MS, MAX_PER_CYCLE };
