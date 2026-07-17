// tests/payments/escrow-service.test.js
const { createEscrowService } = require('../../src/payments/escrow-service');
const { STATES } = require('../../src/payments/escrow-state-machine');

// インメモリの fake リポジトリ（ファイルI/Oを避け、決定論的にテスト）
function makeMemoryRepo() {
  const rows = new Map();
  let seq = 0;
  return {
    create: (rec) => {
      const id = `esc-${++seq}`;
      const row = { ...rec, id, createdAt: 'now' };
      rows.set(id, row);
      return row;
    },
    getById: (id) => rows.get(id) || null,
    update: (id, updates) => {
      const cur = rows.get(id);
      if (!cur) return null;
      const next = { ...cur, ...updates };
      rows.set(id, next);
      return next;
    },
    _rows: rows,
  };
}

function svc() {
  return createEscrowService({ repository: makeMemoryRepo() });
}

describe('escrow-service', () => {
  it('creates a PENDING escrow for an order', () => {
    const s = svc();
    const e = s.create({ orderId: 'order-1', amountSats: 1000, feeRate: 0.015 });
    expect(e.state).toBe(STATES.PENDING);
    expect(e.orderId).toBe('order-1');
    expect(e.id).toBeTruthy();
  });

  it('requires orderId on create', () => {
    expect(() => svc().create({ amountSats: 1 })).toThrow(/orderId/);
  });

  it('markPaid moves PENDING -> HELD and records history', () => {
    const s = svc();
    const e = s.create({ orderId: 'o', amountSats: 1000 });
    const { escrow, actions } = s.markPaid(e.id);
    expect(escrow.state).toBe(STATES.HELD);
    expect(actions).toContain('hold_preimage');
    expect(escrow.history).toHaveLength(1);
    expect(escrow.history[0].event).toBe('PAY');
  });

  it('happy path: pay then verified -> SETTLED reveals preimage', () => {
    const s = svc();
    const e = s.create({ orderId: 'o', amountSats: 1000 });
    s.markPaid(e.id);
    const { escrow, actions, event } = s.evaluate(e.id, { verified: true });
    expect(event).toBe('DELIVER_OK');
    expect(escrow.state).toBe(STATES.SETTLED);
    expect(actions).toEqual(expect.arrayContaining(['reveal_preimage', 'payout_provider', 'collect_fee']));
  });

  it('evaluate WAIT does not change state or append history', () => {
    const s = svc();
    const e = s.create({ orderId: 'o', amountSats: 1000 });
    s.markPaid(e.id);
    const before = s.get(e.id);
    const res = s.evaluate(e.id, { verified: null, deadlinePassed: false });
    expect(res.event).toBe('WAIT');
    expect(res.escrow.state).toBe(STATES.HELD);
    expect(res.escrow.history).toHaveLength(before.history.length);
  });

  it('zero-load suspicion disputes, then refund slashes provider', () => {
    const s = svc();
    const e = s.create({ orderId: 'o', amountSats: 1000 });
    s.markPaid(e.id);
    const disputed = s.evaluate(e.id, { suspectedZeroLoad: true });
    expect(disputed.event).toBe('DELIVER_FAIL');
    expect(disputed.escrow.state).toBe(STATES.DISPUTED);

    const refunded = s.resolveDispute(e.id, 'refund');
    expect(refunded.escrow.state).toBe(STATES.CANCELED);
    expect(refunded.actions).toEqual(expect.arrayContaining(['refund_renter', 'slash_provider']));
  });

  it('throws on missing escrow and invalid transitions', () => {
    const s = svc();
    expect(() => s.markPaid('nope')).toThrow(/not found/);
    const e = s.create({ orderId: 'o', amountSats: 1 });
    // cannot deliver before paying
    expect(() => s.apply(e.id, 'DELIVER_OK')).toThrow(/invalid transition/);
  });

  it('settle computes a prorated split and records it without changing state', () => {
    const s = svc();
    const e = s.create({ orderId: 'o', amountSats: 10000, feeRate: 0.02 });
    s.markPaid(e.id);
    const { escrow, settlement } = s.settle(e.id, { deliveredRatio: 0.5, slaUptimePct: 100 });
    expect(settlement.chargedSats).toBe(5000);
    expect(settlement.renterRefundSats).toBe(5000);
    expect(settlement.providerPayoutSats + settlement.operatorFeeSats).toBe(5000);
    // state unchanged; settlement persisted + history appended
    expect(escrow.state).toBe(STATES.HELD);
    expect(escrow.settlement).toEqual(settlement);
    expect(escrow.history.map((h) => h.event)).toContain('SETTLEMENT_COMPUTED');
  });

  it('records a full audit trail in history', () => {
    const s = svc();
    const e = s.create({ orderId: 'o', amountSats: 1 });
    s.markPaid(e.id);
    s.evaluate(e.id, { verified: false });
    const final = s.resolveDispute(e.id, 'settle');
    expect(final.escrow.history.map((h) => h.event)).toEqual(['PAY', 'DELIVER_FAIL', 'RESOLVE_SETTLE']);
    expect(final.escrow.state).toBe(STATES.SETTLED);
  });
});
