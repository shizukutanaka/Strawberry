// tests/payments/reconciliation.test.js
// 帳簿の突き合わせ。カストディアル運用（借り手の金を運営がいったん預かる）である以上、
// 「預かり金と債務が合っているか」を機械的に確認できないと、ズレても誰も気づけない。
//
// この検査は、直前に見つけた実バグ（係争の返金裁定を受けた注文が台帳に載らず、
// 借り手の 60,000 sats が運営に残ったまま）を uncreditedTerminal として自動検出する。
// 個別の終端経路を人間が思い出して確認するのではなく、不変条件で見張らせるのが要点。
const { reconcile } = require('../../src/payments/reconciliation');

function repo(rows) {
  return {
    getAll: () => rows.slice(),
    getById: (id) => rows.find((r) => r.id === id) || null,
    getByOrderId: (oid) => rows.filter((r) => r.orderId === oid),
  };
}

const deps = (payments, orders, ledger) => ({
  PaymentRepository: repo(payments),
  OrderRepository: repo(orders),
  LedgerRepository: repo(ledger),
});

const paidPayment = (orderId, amount) => ({ id: `p-${orderId}`, orderId, amount, status: 'paid' });
const earning = (orderId, amountSats, operatorFeeSats) => ({
  id: `e-${orderId}`, kind: 'earning', orderId, amountSats, status: 'settled',
  userId: 'prov', breakdown: { operatorFeeSats },
});
const refund = (orderId, amountSats) => ({
  id: `r-${orderId}`, kind: 'refund', orderId, amountSats, status: 'settled', userId: 'renter', breakdown: {},
});

describe('conservation of money', () => {
  it('accepts a fully settled order where credits + fee equal what was paid', () => {
    const r = reconcile(deps(
      [paidPayment('o1', 100000)],
      [{ id: 'o1', status: 'completed' }],
      [earning('o1', 98500, 1500)],
    ));
    expect(r.invariants.conservationHolds).toBe(true);
    expect(r.discrepancies).toEqual([]);
  });

  it('accepts a partially delivered order split between provider and renter', () => {
    const r = reconcile(deps(
      [paidPayment('o1', 100000)],
      [{ id: 'o1', status: 'completed' }],
      [earning('o1', 49250, 750), refund('o1', 50000)],
    ));
    expect(r.invariants.conservationHolds).toBe(true);
    expect(r.totals.providerEarnedSats).toBe(49250);
    expect(r.totals.renterRefundedSats).toBe(50000);
    expect(r.totals.operatorFeeSats).toBe(750);
  });

  it('flags money that appeared from nowhere', () => {
    const r = reconcile(deps(
      [paidPayment('o1', 100000)],
      [{ id: 'o1', status: 'completed' }],
      [earning('o1', 120000, 1500)],
    ));
    expect(r.invariants.conservationHolds).toBe(false);
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0].differenceSats).toBe(21500);
  });

  it('flags money that vanished', () => {
    const r = reconcile(deps(
      [paidPayment('o1', 100000)],
      [{ id: 'o1', status: 'completed' }],
      [earning('o1', 50000, 1500)],
    ));
    expect(r.invariants.conservationHolds).toBe(false);
    expect(r.discrepancies[0].differenceSats).toBe(-48500);
  });
});

describe('no terminal order is left uncredited', () => {
  it('catches a paid, refund-ruled dispute that never reached the ledger', () => {
    // これが実際に起きていたバグ。台帳が completed しか見ていなかったため、
    // 係争で借り手が勝っても金がどこにも計上されなかった。
    const r = reconcile(deps(
      [paidPayment('o1', 60000)],
      [{ id: 'o1', status: 'cancelled', cancelReason: 'dispute_resolved_refund' }],
      [],
    ));
    expect(r.invariants.noUncreditedTerminalOrders).toBe(false);
    expect(r.uncreditedTerminal).toEqual([
      { orderId: 'o1', paidSats: 60000, status: 'cancelled', cancelReason: 'dispute_resolved_refund' },
    ]);
  });

  it('does not flag an order that has not reached a terminal state yet', () => {
    for (const status of ['active', 'matched', 'disputed', 'pending', 'preempting']) {
      const r = reconcile(deps([paidPayment('o1', 60000)], [{ id: 'o1', status }], []));
      expect(r.invariants.noUncreditedTerminalOrders).toBe(true);
    }
  });

  it('does not flag an unpaid order', () => {
    const r = reconcile(deps(
      [{ id: 'p1', orderId: 'o1', amount: 60000, status: 'pending' }],
      [{ id: 'o1', status: 'cancelled', cancelReason: 'payment_timeout' }],
      [],
    ));
    expect(r.invariants.noUncreditedTerminalOrders).toBe(true);
    expect(r.totals.renterPaidSats).toBe(0);
  });
});

describe('no credit without a matching payment', () => {
  // 保存則の検査は「支払い → 台帳」の向きしか見ないので、対応する入金が無い計上を
  // 素通りさせる。実データに対して動かして初めて気づいた: 支払いレコード 2 件に対して
  // 台帳の計上が 125 件あるのに healthy=true が返っていた。
  it('flags a credit whose order has no paid payment', () => {
    const r = reconcile(deps(
      [],
      [{ id: 'o1', status: 'completed' }],
      [earning('o1', 98500, 1500)],
    ));
    expect(r.invariants.noOrphanCredits).toBe(false);
    expect(r.orphanCredits).toEqual([{
      orderId: 'o1', creditedSats: 98500, operatorFeeSats: 1500,
      kinds: ['earning'], status: 'completed',
    }]);
  });

  it('flags a credit whose order no longer exists at all', () => {
    const r = reconcile(deps([], [], [refund('ghost', 5000)]));
    expect(r.orphanCredits[0]).toMatchObject({ orderId: 'ghost', status: 'order_not_found' });
  });

  it('does not flag a credit that has a matching payment', () => {
    const r = reconcile(deps(
      [paidPayment('o1', 100000)],
      [{ id: 'o1', status: 'completed' }],
      [earning('o1', 98500, 1500)],
    ));
    expect(r.invariants.noOrphanCredits).toBe(true);
    expect(r.orphanCredits).toEqual([]);
  });

  it('ignores payout rows, which carry no orderId by design', () => {
    const r = reconcile(deps(
      [paidPayment('o1', 100000)],
      [{ id: 'o1', status: 'completed' }],
      [earning('o1', 98500, 1500),
       { id: 'po1', kind: 'payout', userId: 'prov', amountSats: 40000, status: 'paid', orderId: null }],
    ));
    expect(r.invariants.noOrphanCredits).toBe(true);
  });
});

describe('what the operator is holding', () => {
  it('reports the outstanding liability as credits not yet sent', () => {
    const r = reconcile(deps(
      [paidPayment('o1', 100000)],
      [{ id: 'o1', status: 'completed' }],
      [
        earning('o1', 98500, 1500),
        { id: 'po1', kind: 'payout', userId: 'prov', amountSats: 40000, status: 'paid' },
        { id: 'po2', kind: 'payout', userId: 'prov', amountSats: 10000, status: 'requested' },
      ],
    ));
    // 計上 98,500 のうち 40,000 は送金済み → 58,500 がまだ預かり中
    expect(r.totals.outstandingLiabilitySats).toBe(58500);
    expect(r.totals.payoutPaidSats).toBe(40000);
    expect(r.totals.payoutRequestedSats).toBe(10000);
  });

  it('counts only settled credits, never pending ones', () => {
    const r = reconcile(deps(
      [paidPayment('o1', 100000)],
      [{ id: 'o1', status: 'completed' }],
      [{ ...earning('o1', 98500, 1500), status: 'draft' }],
    ));
    expect(r.totals.providerEarnedSats).toBe(0);
  });

  it('handles an empty system without dividing by anything', () => {
    const r = reconcile(deps([], [], []));
    expect(r.invariants).toMatchObject({ conservationHolds: true, noUncreditedTerminalOrders: true });
    expect(r.totals.outstandingLiabilitySats).toBe(0);
  });
});
