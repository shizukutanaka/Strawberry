// tests/payments/payout-ledger.test.js
// 収益台帳。「借り手が払った sats がプロバイダに届く経路が存在しない」という
// 製品として致命的なギャップを埋めた部分のテスト。
// 二重計上・二重出金・残高超過はどれも実損に直結するので、そこを厚く見る。
const payoutLedger = require('../../src/payments/payout-ledger');

// --- インメモリのリポジトリ fake（createUnique/updateIf を含む実 API を模す） ---
function memLedger() {
  const rows = [];
  let seq = 0;
  return {
    rows,
    getAll: () => rows.slice(),
    getById: (id) => rows.find((r) => r.id === id) || null,
    getByUserId: (userId) => rows.filter((r) => r.userId === userId),
    getByOrderId: (orderId) => rows.filter((r) => r.orderId === orderId),
    create: (rec) => {
      const row = { ...rec, id: `l${++seq}`, createdAt: rec.createdAt || new Date().toISOString() };
      rows.push(row);
      return row;
    },
    createUnique: (rec, predicate) => {
      const existing = rows.find(predicate);
      if (existing) return { ok: false, reason: 'exists', existing };
      const row = { ...rec, id: `l${++seq}`, createdAt: rec.createdAt || new Date().toISOString() };
      rows.push(row);
      return { ok: true, row };
    },
    updateIf: (id, predicate, updates) => {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) return { ok: false, reason: 'not_found' };
      if (!predicate(rows[idx])) return { ok: false, reason: 'condition_failed', current: rows[idx] };
      rows[idx] = { ...rows[idx], ...updates };
      return { ok: true, row: rows[idx] };
    },
  };
}

const memPayments = (byOrder) => ({ getByOrderId: (id) => byOrder[id] || [] });
const memEscrows = (byOrder) => ({ getByOrderId: (id) => byOrder[id] || [] });
const memUsers = (byId) => ({ getById: (id) => byId[id] || null });

function deps({ ledger, payments = {}, escrows = {}, users = {} }) {
  return {
    LedgerRepository: ledger,
    PaymentRepository: memPayments(payments),
    EscrowRepository: memEscrows(escrows),
    UserRepository: memUsers(users),
  };
}

const ORDER = {
  id: 'o1', status: 'completed', providerId: 'prov1', userId: 'renter1', durationMinutes: 60,
};

describe('deliveredRatioOf', () => {
  it('prefers the recorded deliveredRatio', () => {
    expect(payoutLedger.deliveredRatioOf({ ...ORDER, deliveredRatio: 0.42 }))
      .toEqual({ ratio: 0.42, source: 'order.deliveredRatio' });
  });

  it('falls back to measured usage seconds', () => {
    const r = payoutLedger.deliveredRatioOf({ ...ORDER, usageStats: { usageSeconds: 1800 } });
    expect(r.ratio).toBeCloseTo(0.5);
    expect(r.source).toBe('usageStats');
  });

  it('assumes full delivery only for a normal completion with no measurement', () => {
    expect(payoutLedger.deliveredRatioOf(ORDER).ratio).toBe(1);
  });

  it('does NOT assume full delivery when the order ended abnormally', () => {
    // 中断・SLA 違反で計測が欠けているときに 100% 払い出すのは fail-open で、
    // 「受注して即中断 → 満額回収」を成立させてしまう。
    const r = payoutLedger.deliveredRatioOf({ ...ORDER, terminationReason: 'preempted' });
    expect(r.ratio).toBe(0);
    expect(r.source).toBe('unmeasured_abnormal_termination');
  });

  it('clamps a nonsensical ratio into [0,1]', () => {
    expect(payoutLedger.deliveredRatioOf({ ...ORDER, deliveredRatio: 5 }).ratio).toBe(1);
    expect(payoutLedger.deliveredRatioOf({ ...ORDER, deliveredRatio: -3 }).ratio).toBe(0);
  });
});

describe('settlementForOrder', () => {
  it('returns null when the renter never actually paid', () => {
    // pending の invoice しか無い注文でプロバイダに払うと、運営が自腹を切ることになる。
    const d = deps({ ledger: memLedger(), payments: { o1: [{ status: 'pending', amount: 10000 }] } });
    expect(payoutLedger.settlementForOrder(ORDER, d)).toBeNull();
  });

  it('counts only paid payments', () => {
    const d = deps({ ledger: memLedger(), payments: { o1: [
      { status: 'paid', amount: 10000 }, { status: 'pending', amount: 999999 }, { status: 'failed', amount: 5000 },
    ] } });
    const s = payoutLedger.settlementForOrder(ORDER, d);
    expect(s.totalSats).toBe(10000);
  });

  it('splits charged into provider payout + operator fee exactly', () => {
    const d = deps({ ledger: memLedger(), payments: { o1: [{ status: 'paid', amount: 100000 }] } });
    const s = payoutLedger.settlementForOrder(ORDER, d);
    expect(s.providerPayoutSats + s.operatorFeeSats).toBe(s.chargedSats);
    expect(s.chargedSats + s.renterRefundSats).toBe(100000);
    expect(s.operatorFeeSats).toBeGreaterThan(0);
  });

  it('prefers an existing SETTLED escrow settlement over recomputing', () => {
    // 同じ注文に 2 つの異なる金額を持たせない。エスクローが既に計算していればそれが正。
    const d = deps({
      ledger: memLedger(),
      payments: { o1: [{ status: 'paid', amount: 100000 }] },
      escrows: { o1: [{ id: 'e1', state: 'SETTLED', settlement: {
        providerPayoutSats: 777, renterRefundSats: 111, operatorFeeSats: 22, chargedSats: 799,
        breakdown: { total: 910, deliveredRatio: 0.8 },
      } }] },
    });
    const s = payoutLedger.settlementForOrder(ORDER, d);
    expect(s.providerPayoutSats).toBe(777);
    expect(s.source).toBe('escrow:e1');
  });

  it('ignores an escrow that has not settled yet', () => {
    const d = deps({
      ledger: memLedger(),
      payments: { o1: [{ status: 'paid', amount: 100000 }] },
      escrows: { o1: [{ id: 'e1', state: 'HELD', settlement: { providerPayoutSats: 1 } }] },
    });
    expect(payoutLedger.settlementForOrder(ORDER, d).source).toMatch(/^payments:/);
  });

  it('applies no minimum-charge floor when the provider caused the termination', () => {
    // プロバイダ都合の中断に最低課金（既定10%）を効かせると、ゼロワーク課金が成立する。
    const preempted = { ...ORDER, terminationReason: 'preempted', deliveredRatio: 0 };
    const d = deps({ ledger: memLedger(), payments: { o1: [{ status: 'paid', amount: 100000 }] } });
    const s = payoutLedger.settlementForOrder(preempted, d);
    expect(s.chargedSats).toBe(0);
    expect(s.renterRefundSats).toBe(100000);
  });
});

describe('creditOrder', () => {
  it('credits the provider and refunds the renter in one pass', () => {
    const ledger = memLedger();
    const d = deps({ ledger, payments: { o1: [{ status: 'paid', amount: 100000 }] } });
    const order = { ...ORDER, deliveredRatio: 0.5 };
    const res = payoutLedger.creditOrder(order, d);
    expect(res.credited).toBe(true);
    const kinds = res.entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(['earning', 'refund']);
    const earning = res.entries.find((e) => e.kind === 'earning');
    expect(earning.userId).toBe('prov1');
    const refund = res.entries.find((e) => e.kind === 'refund');
    expect(refund.userId).toBe('renter1');
    expect(refund.amountSats).toBe(50000);
  });

  it('is idempotent — a second call credits nothing (no double payment)', () => {
    // これが破れると「掃き出しが 2 回走ったのでプロバイダに 2 倍払う」になる。
    const ledger = memLedger();
    const d = deps({ ledger, payments: { o1: [{ status: 'paid', amount: 100000 }] } });
    expect(payoutLedger.creditOrder(ORDER, d).credited).toBe(true);
    const second = payoutLedger.creditOrder(ORDER, d);
    expect(second.credited).toBe(false);
    expect(second.reason).toBe('already_credited');
    expect(ledger.rows.filter((r) => r.kind === 'earning')).toHaveLength(1);
  });

  it('refuses to credit an order that is not completed', () => {
    const d = deps({ ledger: memLedger(), payments: { o1: [{ status: 'paid', amount: 100000 }] } });
    const res = payoutLedger.creditOrder({ ...ORDER, status: 'active' }, d);
    expect(res.credited).toBe(false);
    expect(res.reason).toBe('order_status_active');
  });

  it('refuses to credit an unpaid order', () => {
    const d = deps({ ledger: memLedger(), payments: {} });
    expect(payoutLedger.creditOrder(ORDER, d)).toEqual({ credited: false, reason: 'unpaid' });
  });
});

describe('balanceFor', () => {
  function seeded() {
    const ledger = memLedger();
    ledger.create({ kind: 'earning', userId: 'u1', amountSats: 10000, status: 'settled' });
    ledger.create({ kind: 'earning', userId: 'u1', amountSats: 5000, status: 'settled' });
    return ledger;
  }

  it('sums settled credits', () => {
    const b = payoutLedger.balanceFor('u1', { LedgerRepository: seeded() });
    expect(b).toMatchObject({ earnedSats: 15000, reservedSats: 0, paidOutSats: 0, availableSats: 15000 });
  });

  it('reserves requested payouts so a second request cannot spend the same sats', () => {
    const ledger = seeded();
    ledger.create({ kind: 'payout', userId: 'u1', amountSats: 12000, status: 'requested' });
    const b = payoutLedger.balanceFor('u1', { LedgerRepository: ledger });
    expect(b.reservedSats).toBe(12000);
    expect(b.availableSats).toBe(3000);
  });

  it('returns reserved sats to the balance when a payout is rejected', () => {
    const ledger = seeded();
    ledger.create({ kind: 'payout', userId: 'u1', amountSats: 12000, status: 'rejected' });
    expect(payoutLedger.balanceFor('u1', { LedgerRepository: ledger }).availableSats).toBe(15000);
  });

  it('does not count another user\'s entries', () => {
    const ledger = seeded();
    ledger.create({ kind: 'earning', userId: 'u2', amountSats: 999999, status: 'settled' });
    expect(payoutLedger.balanceFor('u1', { LedgerRepository: ledger }).earnedSats).toBe(15000);
  });
});

describe('requestPayout', () => {
  function ctx(balanceSats, user = { id: 'u1', payoutAddress: 'lnbc-dest-address', role: 'provider' }) {
    const ledger = memLedger();
    if (balanceSats > 0) ledger.create({ kind: 'earning', userId: 'u1', amountSats: balanceSats, status: 'settled' });
    return { ledger, d: deps({ ledger, users: { u1: user } }) };
  }

  it('creates a requested payout to the stored payout address', () => {
    const { d } = ctx(50000);
    const res = payoutLedger.requestPayout({ userId: 'u1', amountSats: 20000 }, d);
    expect(res.ok).toBe(true);
    expect(res.payout).toMatchObject({ kind: 'payout', status: 'requested', destination: 'lnbc-dest-address' });
    expect(res.balance.availableSats).toBe(30000);
  });

  it('refuses to exceed the available balance', () => {
    const { d } = ctx(50000);
    const res = payoutLedger.requestPayout({ userId: 'u1', amountSats: 50001 }, d);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('insufficient_balance');
  });

  it('refuses a second request that would double-spend the same balance', () => {
    const { d } = ctx(50000);
    expect(payoutLedger.requestPayout({ userId: 'u1', amountSats: 40000 }, d).ok).toBe(true);
    const second = payoutLedger.requestPayout({ userId: 'u1', amountSats: 40000 }, d);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('insufficient_balance');
  });

  it('refuses when no payout address is registered', () => {
    const { d } = ctx(50000, { id: 'u1', role: 'provider' });
    expect(payoutLedger.requestPayout({ userId: 'u1', amountSats: 20000 }, d))
      .toMatchObject({ ok: false, reason: 'no_payout_address' });
  });

  it('rejects non-positive and non-numeric amounts', () => {
    const { d } = ctx(50000);
    for (const bad of [0, -1, null, undefined, 'lots', NaN]) {
      expect(payoutLedger.requestPayout({ userId: 'u1', amountSats: bad }, d).ok).toBe(false);
    }
  });

  it('enforces the minimum payout', () => {
    const { d } = ctx(50000);
    const res = payoutLedger.requestPayout({ userId: 'u1', amountSats: 1 }, d);
    expect(res).toMatchObject({ ok: false, reason: 'below_minimum' });
  });
});

describe('completePayout / rejectPayout', () => {
  function pending() {
    const ledger = memLedger();
    ledger.create({ kind: 'earning', userId: 'u1', amountSats: 50000, status: 'settled' });
    const p = ledger.create({ kind: 'payout', userId: 'u1', amountSats: 20000, status: 'requested' });
    return { ledger, p, d: { LedgerRepository: ledger } };
  }

  it('records the transaction id the operator actually sent', () => {
    const { p, d } = pending();
    const res = payoutLedger.completePayout(p.id, { txid: 'abcd1234', byUserId: 'admin1' }, d);
    expect(res.ok).toBe(true);
    expect(res.payout).toMatchObject({ status: 'paid', txid: 'abcd1234', settledBy: 'admin1' });
  });

  it('refuses to mark a payout sent without a transaction id', () => {
    // txid 無しで paid にできると、台帳上は払ったことになっているのに実際は
    // 送金されていない状態を後から誰も検出できない。
    const { p, d } = pending();
    expect(payoutLedger.completePayout(p.id, { txid: '' }, d)).toEqual({ ok: false, reason: 'txid_required' });
    expect(payoutLedger.completePayout(p.id, {}, d).ok).toBe(false);
  });

  it('cannot complete the same payout twice', () => {
    const { p, d } = pending();
    expect(payoutLedger.completePayout(p.id, { txid: 'abcd1234' }, d).ok).toBe(true);
    const again = payoutLedger.completePayout(p.id, { txid: 'efgh5678' }, d);
    expect(again).toMatchObject({ ok: false, reason: 'not_pending' });
  });

  it('cannot reject a payout that was already paid', () => {
    const { p, d } = pending();
    payoutLedger.completePayout(p.id, { txid: 'abcd1234' }, d);
    expect(payoutLedger.rejectPayout(p.id, { reason: 'oops' }, d).ok).toBe(false);
  });

  it('returns not_found for an unknown payout id', () => {
    const { d } = pending();
    expect(payoutLedger.completePayout('nope', { txid: 'abcd1234' }, d))
      .toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('a completed payout permanently reduces the balance', () => {
    const { p, d } = pending();
    payoutLedger.completePayout(p.id, { txid: 'abcd1234' }, d);
    const b = payoutLedger.balanceFor('u1', d);
    expect(b).toMatchObject({ earnedSats: 50000, reservedSats: 0, paidOutSats: 20000, availableSats: 30000 });
  });
});

describe('pendingPayouts', () => {
  it('lists only requested payouts, oldest first', () => {
    const ledger = memLedger();
    ledger.create({ kind: 'payout', userId: 'u1', amountSats: 1000, status: 'paid', createdAt: '2026-01-01T00:00:00Z' });
    ledger.create({ kind: 'payout', userId: 'u2', amountSats: 2000, status: 'requested', createdAt: '2026-03-01T00:00:00Z' });
    ledger.create({ kind: 'payout', userId: 'u3', amountSats: 3000, status: 'requested', createdAt: '2026-02-01T00:00:00Z' });
    ledger.create({ kind: 'earning', userId: 'u4', amountSats: 4000, status: 'settled' });
    const rows = payoutLedger.pendingPayouts({ LedgerRepository: ledger });
    expect(rows.map((r) => r.userId)).toEqual(['u3', 'u2']);
  });
});
