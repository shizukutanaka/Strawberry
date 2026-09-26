// src/payments/settlement-retry.js
// §3(短期): btc-onchain 二段送金で tx2(運営→貸し手)が失敗した部分決済の
// 自動リトライキュー。これまでの運用は payment_partial_settlement 監査ログを
// 人手で照合して同リクエストを再送する方式だったが、滞留中は資金が運営に
// 留まり続ける。エスクロー行にリトライ状態を持たせ、指数バックオフで自動再試行する。
//
// 冪等性: tx1 完了後のみキューに乗る（state==='HELD' && txBorrowerToOperator 済み）。
// 再試行するのは tx2 のみで二重請求は発生しない。クレームは updateIf で原子的に行い、
// 手動再送・poller・強制リトライの競合を防ぐ。
const { appendAuditLog } = require('../utils/audit-log');
const { logger } = require('../utils/logger');

const BASE_DELAY_MS = Math.max(1000, parseInt(process.env.SETTLEMENT_RETRY_BASE_MS || '30000', 10));
const MAX_DELAY_MS = Math.max(BASE_DELAY_MS, parseInt(process.env.SETTLEMENT_RETRY_MAX_DELAY_MS || '1800000', 10));
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.SETTLEMENT_RETRY_MAX_ATTEMPTS || '20', 10));

function _repo(repository) {
  return repository || require('../db/json/EscrowRepository');
}

function _backoffMs(attempts) {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempts), MAX_DELAY_MS);
}

/**
 * 部分決済をリトライキューへ登録。tx2 失敗時に btc-onchain から呼ぶ。
 * 既に pending エントリがある場合はエラーを更新するだけ（重複登録しない）。
 */
function enqueue(escrowId, { orderId, operatorWallet, lenderWallet, payout, total, error } = {}, repository) {
  const repo = _repo(repository);
  const now = new Date().toISOString();
  const res = repo.updateIf(
    escrowId,
    (e) => e.state === 'HELD' && !!e.txBorrowerToOperator && !e.txOperatorToLender
        && (!e.settlementRetry || e.settlementRetry.status !== 'pending'),
    {
      settlementRetry: {
        status: 'pending', attempts: 0, inFlight: false,
        nextAttemptAt: new Date(Date.now() + BASE_DELAY_MS).toISOString(),
        lastError: String(error || '').slice(0, 500),
        enqueuedAt: now,
      },
      // リトライ実行に必要な payload をエスクローへ固定（リクエスト非依存で回復可能に）
      settlementPayload: { orderId, operatorWallet, lenderWallet, payout, total },
      updatedAt: now,
    }
  );
  if (res && res.ok) {
    appendAuditLog('settlement_retry_enqueued', { escrowId, orderId, payout, nextAttemptInMs: BASE_DELAY_MS });
  }
  return res;
}

/** 期限到来の pending エントリを返す（paymentId はエスクロー id）。 */
function dueRetries(now = Date.now(), repository) {
  const repo = _repo(repository);
  return repo.getAll().filter((e) =>
    e.state === 'HELD' && e.txBorrowerToOperator && !e.txOperatorToLender
    && e.settlementRetry && e.settlementRetry.status === 'pending' && !e.settlementRetry.inFlight
    && Date.parse(e.settlementRetry.nextAttemptAt || 0) <= now
  );
}

/** 監視用: キュー状態の一覧（pending / dead）。 */
function list(repository) {
  const repo = _repo(repository);
  return repo.getAll()
    .filter((e) => e.settlementRetry && ['pending', 'dead'].includes(e.settlementRetry.status))
    .map((e) => ({
      escrowId: e.id, orderId: e.orderId, state: e.state,
      retry: e.settlementRetry, payload: e.settlementPayload,
    }));
}

/**
 * 1件のリトライを実行。sendBTC は注入可能（テスト用）。成功時は HELD→SETTLED を
 * updateIf で原子的に行い、PaymentRepository へ paid レコードを補完する
 * （btc-onchain 直送パスと同じ不変条件 — レコードが無いと order の start/stop が詰まる）。
 */
async function retryOne(escrowId, { sendBTC, repository, paymentRepository, orderRepository } = {}) {
  const repo = _repo(repository);
  const escrow = repo.getById(escrowId);
  if (!escrow || !escrow.settlementRetry || !escrow.settlementPayload) return { retried: false, reason: 'not_queued' };

  // 原子的クレーム: pending かつ非 inFlight のみ取得。競合した側は諦める。
  const claim = repo.updateIf(
    escrowId,
    (e) => e.state === 'HELD' && !e.txOperatorToLender
        && e.settlementRetry && e.settlementRetry.status === 'pending' && !e.settlementRetry.inFlight,
    { settlementRetry: { ...escrow.settlementRetry, inFlight: true, lastAttemptAt: new Date().toISOString() } }
  );
  if (!claim || !claim.ok) return { retried: false, reason: 'already_claimed' };

  const { orderId, operatorWallet, lenderWallet, payout } = escrow.settlementPayload;
  const sender = sendBTC || require('../api/utils/btc-payment').sendBTC;
  try {
    const tx2 = await sender(operatorWallet, lenderWallet, payout);
    repo.updateIf(
      escrowId,
      (e) => e.state === 'HELD' && !e.txOperatorToLender,
      {
        state: 'SETTLED', txOperatorToLender: tx2.txid, updatedAt: new Date().toISOString(),
        settlementRetry: { ...claim.row.settlementRetry, inFlight: false, status: 'succeeded', succeededAt: new Date().toISOString() },
      }
    );
    _ensurePaidRecord(orderId, paymentRepository, orderRepository, tx2.txid);
    appendAuditLog('settlement_retry_succeeded', { escrowId, orderId, txOperatorToLender: tx2.txid });
    logger.info(`[settlement-retry] tx2 recovered for escrow ${escrowId} (order ${orderId})`);
    return { retried: true, ok: true, txid: tx2.txid };
  } catch (err) {
    const attempts = (escrow.settlementRetry.attempts || 0) + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    repo.updateIf(
      escrowId,
      (e) => e.settlementRetry && e.settlementRetry.inFlight,
      {
        settlementRetry: {
          ...claim.row.settlementRetry, inFlight: false, attempts,
          status: exhausted ? 'dead' : 'pending',
          lastError: String(err.message || err).slice(0, 500),
          nextAttemptAt: exhausted ? null : new Date(Date.now() + _backoffMs(attempts)).toISOString(),
        },
        updatedAt: new Date().toISOString(),
      }
    );
    appendAuditLog(exhausted ? 'settlement_retry_exhausted' : 'settlement_retry_failed', {
      escrowId, orderId, attempts, error: String(err.message || err).slice(0, 500),
    });
    if (exhausted) {
      // 資金が運営に滞留したまま自動回復を断念 — 人手照合が必要。監査ログが最後の証跡。
      logger.error(`[CRITICAL] settlement-retry exhausted for escrow ${escrowId} (order ${orderId}) after ${attempts} attempts — manual reconciliation required`);
    }
    return { retried: true, ok: false, attempts, exhausted, error: err.message };
  }
}

// btc-onchain 直送パスが行う paid レコード補完と同等のものをリトライ成功時にも行う。
function _ensurePaidRecord(orderId, paymentRepository, orderRepository, txid) {
  try {
    const payRepo = paymentRepository || require('../db/json/PaymentRepository');
    const ordRepo = orderRepository || require('../db/json/OrderRepository');
    const order = ordRepo.getById(orderId);
    const existing = (payRepo.getByOrderId(orderId) || []).find((p) => p.status === 'paid');
    if (!existing && order) {
      payRepo.create({
        orderId, userId: order.userId,
        amount: Math.round((order.totalPrice || 0) * 1e8) || undefined,
        status: 'paid', method: 'btc_onchain', txid, paidAt: new Date().toISOString(),
      });
    }
  } catch (e) {
    logger.warn(`[settlement-retry] paid-record write failed for order ${orderId}: ${e.message}`);
  }
}

/** poller からの1スイープ。due なエントリを順に retryOne する。 */
async function pollOnce(opts = {}) {
  const now = opts.now || Date.now();
  const due = dueRetries(now, opts.repository);
  const results = [];
  for (const e of due) {
    results.push(await retryOne(e.id, opts));
  }
  return { scanned: due.length, results };
}

/** 強制再試行（admin）: nextAttemptAt を現在に戻して即 retryOne。 */
async function forceRetry(escrowId, opts = {}) {
  const repo = _repo(opts.repository);
  const escrow = repo.getById(escrowId);
  if (!escrow || !escrow.settlementRetry) return { ok: false, reason: 'not_queued' };
  repo.update(escrowId, {
    settlementRetry: { ...escrow.settlementRetry, status: 'pending', inFlight: false, nextAttemptAt: new Date().toISOString() },
  });
  return retryOne(escrowId, opts);
}

module.exports = {
  enqueue, dueRetries, list, retryOne, pollOnce, forceRetry,
  BASE_DELAY_MS, MAX_DELAY_MS, MAX_ATTEMPTS,
};
