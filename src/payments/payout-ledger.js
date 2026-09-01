// src/payments/payout-ledger.js
// 収益台帳と出金。**プロバイダに実際にお金が届く経路**を作るためのモジュール。
//
// ── なぜ必要だったか（要件の見直し）────────────────────────────────────────
// この製品には決済経路が 2 本あり、どちらもプロバイダへ金を届けていなかった。
//
//   1. Lightning（`POST /payments/order/:id`）: 借り手が invoice を払うと sats は
//      運営ノードに着金する。invoice-poller が payment を paid にして注文が進む。
//      **その後、プロバイダへ送る処理はどこにも無い。** 注文が完了しても運営が
//      全額を持ったまま終わる。
//   2. エスクロー FSM（`POST /marketplace/escrow/*`）: DELIVER_OK で
//      `payout_provider` という action を返すが、(a) 本番の呼び出し側は
//      `createEscrowService()` を lnAdapter 無しで生成しており action は実行されず、
//      (b) 実行されたとしても `escrow.providerInvoice` はコード上のどこからも
//      書き込まれていない（grep 済）ので送金先が無い。
//
// つまり「エスクローで払い出す」という要件は**実装されていないだけでなく、
// そのままでは成立しない**。hold invoice の preimage を公開すると資金は運営に入る。
// プロバイダへの支払いはそこから**別の送金**として出ていく必要があり、
// FSM の 1 遷移で完結する話ではない。さらに hold invoice は HTLC の CLTV 上限に
// 縛られ、数日を超えるレンタルを保持できない。
//
// ── 置き換えた設計（単純化）──────────────────────────────────────────────
// 運営がいったん資金を預かる（既にそうなっている）ことを前提に、**台帳**を置く。
//   - 注文が完了し、借り手の支払いが確認できたら、実提供量に応じて
//     provider へ `earning`(+)、借り手へ未提供分の `refund`(+) を計上する。
//   - 受取人は残高の範囲で `payout` を申請し、運営が実送金して txid を記録する。
// 残高は仕訳の合計で導出する（保存しない）。二重計上は orderId 単位の
// `createUnique` で原子的に防ぐ。
//
// ── 正直に書いておく限界 ──────────────────────────────────────────────────
//  * 送金そのものは自動化していない。運営が LN/on-chain で送り、txid を記録する。
//    ノード無しで「自動送金済み」と称するのは、この製品が避けてきた種類の嘘になる。
//  * したがって運営が送金しなければ資金は動かない（カストディアル。信頼が要る）。
//    非カストディアル化には貸し手ごとの LN 接続が要り、別の作業になる。
const LedgerRepository = require('../db/json/LedgerRepository');
const { computeSettlement } = require('./settlement-calculator');
const { FEE_RATE } = require('./fee-rate');

// 出金の最低額。少額出金は LN 手数料・運用手間に対して割に合わない。
const MIN_PAYOUT_SATS = (() => {
  const v = parseInt(process.env.PAYOUT_MIN_SATS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 1000;
})();

const KINDS = Object.freeze(['earning', 'refund', 'payout', 'adjustment']);
const PAYOUT_STATUSES = Object.freeze(['requested', 'paid', 'rejected']);

// 収益計上の対象になる注文ステータス。
//
// **completed だけでは足りない。** この製品で異常終了はすべて 'cancelled' に集約され、
// 区別は cancelReason が持つ。そして cancelled になる経路のうち複数は「借り手が既に
// 払ったあと」に起きる（係争の返金裁定・マッチ期限切れ・借り手のキャンセル・
// プロバイダの拒否）。completed しか見ていなかったため、
// **係争で借り手が勝っても 1 sat も返らず、運営が全額持ったままだった**
// （実サーバで確認: 60,000 sats を払った注文が refund 裁定を受け、
// 掃き出しは credited=0、借り手の残高は 0 のまま）。
const CREDITABLE_ORDER_STATUSES = Object.freeze(new Set(['completed', 'cancelled']));

// キャンセルのうち「実際に稼働していた」もの。ここだけ実提供量で按分し、
// それ以外のキャンセルは提供ゼロ＝全額返金として扱う。
// 最低課金の床（既定 10%）も効かせない: 床は*借り手都合の即時解約*を想定した
// セットアップ費であって、係争で借り手が勝った注文やプロバイダが断った注文に
// 課してよいものではない。
const DELIVERED_CANCEL_REASONS = Object.freeze(new Set(['active_timeout']));

// 借り手に全額返す（提供が無かった）と判断するキャンセル理由。
// 明示的に列挙し、未知の理由が増えたときは**全額返金側**に倒す
// （知らない理由で課金を続けるより、返しすぎる方が安全）。
const FULL_REFUND_CANCEL_REASONS = Object.freeze(new Set([
  'dispute_resolved_refund', 'dispute_auto_resolved_refund',
  'match_timeout', 'user_cancelled', 'provider_rejected', 'payment_timeout',
]));

function num(v, def = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

/**
 * 注文の実提供割合を求める。**測定値が無いときに 1.0 と決めつけない**のが要点で、
 * 中断・SLA 違反による終了は必ず deliveredRatio が記録されている経路を通る。
 * 通常完了（terminationReason 無し）で測定値が欠けている場合のみ 1.0 とみなす
 * （最後まで走り切った注文で計測だけが落ちたケース）。
 * @returns {{ratio:number, source:string}}
 */
function deliveredRatioOf(order) {
  // キャンセルされた注文は「最後まで走った」の推定を絶対に適用しない。
  // 稼働実績があるのは active_timeout だけで、それも計測値がある場合に限る。
  if (order.status === 'cancelled' && !DELIVERED_CANCEL_REASONS.has(order.cancelReason)) {
    return { ratio: 0, source: `cancelled:${order.cancelReason || 'unspecified'}` };
  }
  if (typeof order.deliveredRatio === 'number' && Number.isFinite(order.deliveredRatio)) {
    return { ratio: Math.max(0, Math.min(1, order.deliveredRatio)), source: 'order.deliveredRatio' };
  }
  const totalSeconds = num(order.durationMinutes) * 60;
  const used = order.usageStats && num(order.usageStats.usageSeconds, NaN);
  if (totalSeconds > 0 && Number.isFinite(used)) {
    return { ratio: Math.max(0, Math.min(1, used / totalSeconds)), source: 'usageStats' };
  }
  // 通常完了で計測だけが落ちた場合に限り全量とみなす。
  if (order.status === 'completed' && !order.terminationReason) {
    return { ratio: 1, source: 'assumed_full_completion' };
  }
  return { ratio: 0, source: 'unmeasured_abnormal_termination' };
}

/**
 * 注文に対して借り手が実際に払った総額（sats）。paid の支払いレコードのみ数える。
 * pending の invoice を数えると「払っていない注文でプロバイダに払う」ことになる。
 */
function paidSatsForOrder(orderId, deps) {
  const PaymentRepo = deps.PaymentRepository || require('../db/json/PaymentRepository');
  const rows = PaymentRepo.getByOrderId ? (PaymentRepo.getByOrderId(orderId) || []) : [];
  return rows
    .filter((p) => p.status === 'paid')
    .reduce((sum, p) => sum + Math.max(0, Math.round(num(p.amount))), 0);
}

/**
 * 注文 1 件の精算内訳を求める。エスクローが既に settlement を計算していれば
 * それを正とする（同じ注文について 2 つの異なる金額を持たないため）。
 * @returns {object|null} 支払い実績が無ければ null（＝計上しない）
 */
function settlementForOrder(order, deps = {}) {
  const EscrowRepo = deps.EscrowRepository || require('../db/json/EscrowRepository');
  const escrows = EscrowRepo.getByOrderId ? (EscrowRepo.getByOrderId(order.id) || []) : [];
  const settled = escrows.find((e) => e.settlement && e.state === 'SETTLED');
  if (settled) {
    const s = settled.settlement;
    return {
      totalSats: num(s.breakdown && s.breakdown.total, s.chargedSats + s.renterRefundSats),
      providerPayoutSats: num(s.providerPayoutSats),
      renterRefundSats: num(s.renterRefundSats),
      operatorFeeSats: num(s.operatorFeeSats),
      chargedSats: num(s.chargedSats),
      source: `escrow:${settled.id}`,
      deliveredRatio: num(s.breakdown && s.breakdown.deliveredRatio, 0),
    };
  }

  const totalSats = paidSatsForOrder(order.id, deps);
  if (totalSats <= 0) return null; // 借り手が払っていない注文は計上しない

  const { ratio, source } = deliveredRatioOf(order);
  const slaUptimePct = order.slaBreach ? Math.round(ratio * 100) : 100;
  // プロバイダ都合の終了（中断・ハートビート途絶）と、完了しなかったキャンセルには
  // 最低課金の床を効かせない。床は*借り手都合の即時解約*を想定したセットアップ費で、
  // 「受注 → 即中断 → 最低課金だけ回収」や「係争で負けても 10% は取る」を
  // 成立させてはいけない。
  const providerFault = order.terminationReason === 'preempted'
    || order.slaBreach === true
    || order.status === 'cancelled';
  const s = computeSettlement(
    { totalSats, deliveredRatio: ratio, slaUptimePct, feeRate: FEE_RATE },
    providerFault ? { minChargeRatio: 0 } : {},
  );
  return { ...s, totalSats, source: `payments:${source}`, deliveredRatio: ratio };
}

/**
 * 注文 1 件を台帳に計上する。**同じ注文を二度計上しない**（createUnique で原子的）。
 * @returns {{credited:boolean, reason?:string, entries?:object[]}}
 */
function creditOrder(order, deps = {}) {
  if (!order || !order.id) return { credited: false, reason: 'no_order' };
  if (!CREDITABLE_ORDER_STATUSES.has(order.status)) {
    return { credited: false, reason: `order_status_${order.status}` };
  }
  const Ledger = deps.LedgerRepository || LedgerRepository;
  const existing = (Ledger.getByOrderId(order.id) || []).filter((e) => e.kind === 'earning' || e.kind === 'refund');
  if (existing.length > 0) return { credited: false, reason: 'already_credited', entries: existing };

  const settlement = settlementForOrder(order, deps);
  if (!settlement) return { credited: false, reason: 'unpaid' };

  const now = new Date().toISOString();
  const entries = [];

  if (order.providerId && settlement.providerPayoutSats > 0) {
    const res = Ledger.createUnique(
      {
        kind: 'earning',
        userId: order.providerId,
        role: 'provider',
        orderId: order.id,
        amountSats: settlement.providerPayoutSats,
        status: 'settled',
        createdAt: now,
        breakdown: {
          totalSats: settlement.totalSats,
          chargedSats: settlement.chargedSats,
          operatorFeeSats: settlement.operatorFeeSats,
          deliveredRatio: settlement.deliveredRatio,
          source: settlement.source,
        },
      },
      (r) => r.orderId === order.id && r.kind === 'earning',
    );
    if (res.ok) entries.push(res.row);
    else return { credited: false, reason: 'already_credited', entries: [res.existing] };
  }

  // 未提供分は借り手に返す義務がある。ここに載せないと「運営が黙って持っている」
  // のと同じで、台帳を作った意味が無い。
  if (order.userId && settlement.renterRefundSats > 0) {
    const res = Ledger.createUnique(
      {
        kind: 'refund',
        userId: order.userId,
        role: 'renter',
        orderId: order.id,
        amountSats: settlement.renterRefundSats,
        status: 'settled',
        createdAt: now,
        breakdown: { totalSats: settlement.totalSats, deliveredRatio: settlement.deliveredRatio, source: settlement.source },
      },
      (r) => r.orderId === order.id && r.kind === 'refund',
    );
    if (res.ok) entries.push(res.row);
  }

  if (entries.length === 0) return { credited: false, reason: 'nothing_to_credit' };
  return { credited: true, entries, settlement };
}

/**
 * ユーザーの残高。仕訳の合計で導出する。
 *   earned    … earning + refund + adjustment(+) の合計
 *   reserved  … 申請中(requested)の出金（残高から先に引いておく。二重申請防止）
 *   paidOut   … 送金済み(paid)の出金
 *   available … earned - reserved - paidOut
 */
function balanceFor(userId, deps = {}) {
  const Ledger = deps.LedgerRepository || LedgerRepository;
  const rows = Ledger.getByUserId(userId) || [];
  let earned = 0, reserved = 0, paidOut = 0;
  for (const r of rows) {
    const amt = Math.max(0, Math.round(num(r.amountSats)));
    if (r.kind === 'earning' || r.kind === 'refund' || r.kind === 'adjustment') {
      if (r.status === 'settled') earned += amt;
    } else if (r.kind === 'payout') {
      if (r.status === 'requested') reserved += amt;
      else if (r.status === 'paid') paidOut += amt;
    }
  }
  return { earnedSats: earned, reservedSats: reserved, paidOutSats: paidOut, availableSats: earned - reserved - paidOut };
}

/**
 * 出金申請。残高を超える申請は拒否する。送金先はサーバ側が保持する
 * `user.payoutAddress` のみを使い、リクエストボディからは受け取らない
 * （受け取ると、トークンを盗んだ攻撃者が送金先だけ差し替えて資金を抜ける）。
 */
function requestPayout({ userId, amountSats }, deps = {}) {
  const Ledger = deps.LedgerRepository || LedgerRepository;
  const UserRepo = deps.UserRepository || require('../db/json/UserRepository');
  const user = UserRepo.getById(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };
  const destination = user.payoutAddress;
  if (!destination) return { ok: false, reason: 'no_payout_address' };

  const amount = Math.round(num(amountSats));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'invalid_amount' };
  if (amount < MIN_PAYOUT_SATS) return { ok: false, reason: 'below_minimum', minimumSats: MIN_PAYOUT_SATS };

  const balance = balanceFor(userId, deps);
  if (amount > balance.availableSats) {
    return { ok: false, reason: 'insufficient_balance', balance };
  }
  const row = Ledger.create({
    kind: 'payout',
    userId,
    role: user.role === 'provider' ? 'provider' : 'renter',
    orderId: null,
    amountSats: amount,
    status: 'requested',
    destination,
    txid: null,
    requestedAt: new Date().toISOString(),
  });
  return { ok: true, payout: row, balance: balanceFor(userId, deps) };
}

/** 運営が実送金したことを記録する（txid 必須）。 */
function completePayout(payoutId, { txid, byUserId } = {}, deps = {}) {
  const Ledger = deps.LedgerRepository || LedgerRepository;
  if (!txid || typeof txid !== 'string' || txid.length < 4) return { ok: false, reason: 'txid_required' };
  const res = Ledger.updateIf(
    payoutId,
    (r) => r.kind === 'payout' && r.status === 'requested',
    { status: 'paid', txid, paidAt: new Date().toISOString(), settledBy: byUserId || null },
  );
  if (!res.ok) return { ok: false, reason: res.reason === 'not_found' ? 'not_found' : 'not_pending', current: res.current };
  return { ok: true, payout: res.row };
}

/** 出金申請を却下する（残高は自動的に戻る — reserved から外れるだけ）。 */
function rejectPayout(payoutId, { reason, byUserId } = {}, deps = {}) {
  const Ledger = deps.LedgerRepository || LedgerRepository;
  const res = Ledger.updateIf(
    payoutId,
    (r) => r.kind === 'payout' && r.status === 'requested',
    { status: 'rejected', rejectedReason: reason || null, rejectedAt: new Date().toISOString(), settledBy: byUserId || null },
  );
  if (!res.ok) return { ok: false, reason: res.reason === 'not_found' ? 'not_found' : 'not_pending', current: res.current };
  return { ok: true, payout: res.row };
}

function listEntries(userId, { limit = 50, offset = 0 } = {}, deps = {}) {
  const Ledger = deps.LedgerRepository || LedgerRepository;
  const rows = (Ledger.getByUserId(userId) || [])
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { total: rows.length, entries: rows.slice(offset, offset + limit) };
}

function pendingPayouts(deps = {}) {
  const Ledger = deps.LedgerRepository || LedgerRepository;
  return (Ledger.getAll() || [])
    .filter((r) => r.kind === 'payout' && r.status === 'requested')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

module.exports = {
  KINDS,
  DELIVERED_CANCEL_REASONS,
  FULL_REFUND_CANCEL_REASONS,
  PAYOUT_STATUSES,
  MIN_PAYOUT_SATS,
  CREDITABLE_ORDER_STATUSES,
  deliveredRatioOf,
  paidSatsForOrder,
  settlementForOrder,
  creditOrder,
  balanceFor,
  requestPayout,
  completePayout,
  rejectPayout,
  listEntries,
  pendingPayouts,
};
