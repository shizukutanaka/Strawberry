// src/payments/reconciliation.js
// 帳簿の突き合わせ。運営が「今いくら預かっていて、いくら払う義務があるか」を
// いつでも答えられるようにする。
//
// ── なぜ必要か ────────────────────────────────────────────────────────────
// この製品はカストディアル（借り手の支払いは運営ノードに着金し、そこから
// プロバイダへ送る）。つまり運営は**他人の金を預かっている**。預かり金と債務が
// 合っているかを機械的に確認できなければ、ズレが出ても誰も気づけない。
//
// 実際、係争の返金裁定を受けた注文が台帳に載らず「借り手が払った 60,000 sats が
// どこにも計上されないまま運営に残る」というバグがあった（修正済み）。
// この突き合わせがあれば、その注文は uncreditedTerminal に 1 件として即座に出る。
// 個別の経路を人間が思い出して確認するのではなく、**終端に達した支払い済み注文で
// 台帳に載っていないものはゼロであるべき**という不変条件で機械に見張らせる。
//
// ── 検査する不変条件 ──────────────────────────────────────────────────────
//  1. 保存則: 注文ごとに credited(貸し手の取り分 + 借り手への返金) + 運営手数料
//     === 借り手が実際に払った額。金が湧いても消えてもいけない。
//  2. 取りこぼしゼロ: 終端状態（completed / cancelled）かつ支払い済みの注文は
//     すべて台帳に計上済みであること。
//  3. 出所のない計上ゼロ: 台帳の計上はすべて、実際に受け取った支払いに紐づくこと。
//     1 の検査は「支払い → 台帳」の向きしか見ないため、対応する入金が無い計上
//     （＝受け取っていない金を払う約束）を素通りさせる。実データに対して動かして
//     初めて気づいた: 支払いレコードが 2 件しか無いのに台帳の計上が 125 件あり、
//     それでも healthy=true が返っていた。両方向を見ないと監査にならない。
//
// 読み取り専用。ここで自動修復はしない（帳簿の不一致を黙って書き換えるのは、
// 検出できる問題を検出できない問題に変えるだけ）。
const { computeSettlement: _computeSettlement } = require('./settlement-calculator');
const payoutLedger = require('./payout-ledger');

function round(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

/**
 * 帳簿を突き合わせる。
 * @returns {{
 *   totals: object, invariants: object,
 *   discrepancies: object[], uncreditedTerminal: object[]
 * }}
 */
function reconcile(deps = {}) {
  const PaymentRepo = deps.PaymentRepository || require('../db/json/PaymentRepository');
  const OrderRepo = deps.OrderRepository || require('../db/json/OrderRepository');
  const Ledger = deps.LedgerRepository || require('../db/json/LedgerRepository');

  // 1. 借り手から実際に受け取った額（注文ごと）
  const paidByOrder = new Map();
  for (const p of PaymentRepo.getAll() || []) {
    if (p.status !== 'paid' || !p.orderId) continue;
    paidByOrder.set(p.orderId, (paidByOrder.get(p.orderId) || 0) + round(p.amount));
  }

  // 2. 台帳の仕訳を注文ごとに集計
  const ledgerRows = Ledger.getAll() || [];
  const creditsByOrder = new Map();
  let totalEarned = 0, totalRefunded = 0, totalFees = 0;
  let payoutRequested = 0, payoutPaid = 0;
  for (const r of ledgerRows) {
    const amt = round(r.amountSats);
    if (r.kind === 'earning' || r.kind === 'refund' || r.kind === 'adjustment') {
      if (r.status !== 'settled') continue;
      if (r.kind === 'earning') totalEarned += amt;
      if (r.kind === 'refund') totalRefunded += amt;
      totalFees += round(r.breakdown && r.breakdown.operatorFeeSats);
      if (r.orderId) {
        const cur = creditsByOrder.get(r.orderId) || { credited: 0, fee: 0, kinds: [] };
        cur.credited += amt;
        // 手数料は earning 側の breakdown にのみ入る（refund 側にも入れると二重に数える）
        if (r.kind === 'earning') cur.fee += round(r.breakdown && r.breakdown.operatorFeeSats);
        cur.kinds.push(r.kind);
        creditsByOrder.set(r.orderId, cur);
      }
    } else if (r.kind === 'payout') {
      if (r.status === 'requested') payoutRequested += amt;
      else if (r.status === 'paid') payoutPaid += amt;
    }
  }
  // 注文に紐づく手数料は earning の breakdown から数え直す（上のループの totalFees は
  // refund 側の breakdown を含みうるので、注文単位の合計を正とする）
  totalFees = 0;
  for (const v of creditsByOrder.values()) totalFees += v.fee;

  // 3. 不変条件の検査
  const discrepancies = [];
  const uncreditedTerminal = [];
  let totalPaid = 0;
  for (const [orderId, paidSats] of paidByOrder) {
    totalPaid += paidSats;
    const order = OrderRepo.getById(orderId);
    const credit = creditsByOrder.get(orderId);
    if (!credit) {
      // 終端に達しているのに計上されていない＝掃き出しが扱えていない経路がある。
      if (order && payoutLedger.CREDITABLE_ORDER_STATUSES.has(order.status)) {
        uncreditedTerminal.push({
          orderId, paidSats, status: order.status,
          cancelReason: order.cancelReason || null,
        });
      }
      continue;
    }
    const sum = credit.credited + credit.fee;
    if (sum !== paidSats) {
      discrepancies.push({
        orderId, paidSats, creditedSats: credit.credited, operatorFeeSats: credit.fee,
        sum, differenceSats: sum - paidSats,
        status: order ? order.status : null,
        kinds: credit.kinds,
      });
    }
  }

  // 4. 運営が保持しているべき額
  //    受け取った額 − 既に送金した額。このうち手数料分は運営の収益で、
  //    残り（未出金の残高）は他人の金＝債務。
  const outstandingLiability = totalEarned + totalRefunded - payoutPaid;

  // 5. 出所のない計上: 台帳に載っているが、対応する入金が無い注文。
  //    運営が受け取っていない金を支払う約束をしている状態にあたる。
  const orphanCredits = [];
  for (const [orderId, credit] of creditsByOrder) {
    if (paidByOrder.has(orderId)) continue;
    const order = OrderRepo.getById(orderId);
    orphanCredits.push({
      orderId, creditedSats: credit.credited, operatorFeeSats: credit.fee,
      kinds: credit.kinds, status: order ? order.status : 'order_not_found',
    });
  }

  return {
    totals: {
      renterPaidSats: totalPaid,           // 借り手から受け取った総額
      providerEarnedSats: totalEarned,     // 貸し手に計上した総額
      renterRefundedSats: totalRefunded,   // 借り手に返金として計上した総額
      operatorFeeSats: totalFees,          // 運営手数料（収益）
      payoutRequestedSats: payoutRequested, // 送金待ち（申請中）
      payoutPaidSats: payoutPaid,          // 送金済み
      outstandingLiabilitySats: outstandingLiability, // 未払いの債務（預かり中）
    },
    invariants: {
      conservationHolds: discrepancies.length === 0,
      noUncreditedTerminalOrders: uncreditedTerminal.length === 0,
      noOrphanCredits: orphanCredits.length === 0,
      paidOrders: paidByOrder.size,
      creditedOrders: creditsByOrder.size,
    },
    discrepancies,
    uncreditedTerminal,
    orphanCredits,
  };
}

module.exports = { reconcile };
