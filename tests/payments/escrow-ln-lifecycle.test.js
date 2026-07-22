// Contract test for the full hold-invoice escrow money-movement lifecycle,
// driven through the mock LN adapter. This is the end-to-end proof that the
// escrow FSM + settlement calculator + action-executor + ln-adapter actually
// move funds when wired together — the capability the AGENT_HANDBOOK flags as
// P1-1. It also locks in the create()-persists-preimage/providerInvoice fix
// (without it, payout_provider had no invoice to pay and settle silently paid
// nothing).
const { createEscrowService } = require('../../src/payments/escrow-service');
const { createMockLnAdapter } = require('../../src/payments/ln-adapter');

// In-memory repository so the test is hermetic (no data/ JSON files touched).
function makeMemRepo() {
  const rows = new Map();
  let seq = 0;
  return {
    create(rec) { const id = `esc-${++seq}`; const row = { id, ...rec }; rows.set(id, row); return row; },
    getById(id) { return rows.get(id) || null; },
    getByOrderId(orderId) { return [...rows.values()].filter((r) => r.orderId === orderId); },
    update(id, patch) { const row = { ...rows.get(id), ...patch }; rows.set(id, row); return row; },
    updateIf(id, pred, patch) {
      const cur = rows.get(id);
      if (!cur || !pred(cur)) return { ok: false, row: cur || null };
      const row = { ...cur, ...patch }; rows.set(id, row); return { ok: true, row };
    },
  };
}

describe('escrow LN money-movement lifecycle (mock adapter)', () => {
  it('happy path: create -> markPaid -> settle -> DELIVER_OK settles the hold invoice and pays the provider', async () => {
    const adapter = createMockLnAdapter();
    const svc = createEscrowService({ repository: makeMemRepo(), lnAdapter: adapter });

    const escrow = svc.create({
      orderId: 'order-happy',
      amountSats: 10000,
      feeRate: 0.1, // 10% operator fee
      preimage: 'secret-preimage',
      preimageHash: 'hash-of-preimage',
      providerInvoice: 'lnbc-provider-payout',
    });
    expect(escrow.state).toBe('PENDING');
    expect(escrow.providerInvoice).toBe('lnbc-provider-payout'); // create now persists it

    svc.markPaid(escrow.id);           // PENDING -> HELD
    svc.settle(escrow.id, { deliveredRatio: 1, slaUptimePct: 100 }); // compute payout
    const { event } = svc.apply(escrow.id, 'DELIVER_OK'); // HELD -> SETTLED (reveal_preimage, payout_provider, collect_fee)
    expect(event).toBe('DELIVER_OK');

    // runActions is fire-and-forget inside apply(); let the microtask flush.
    await new Promise((r) => setImmediate(r));

    const names = adapter.calls.map((c) => c[0]);
    expect(names).toContain('settleHoldInvoice'); // reveal_preimage
    expect(names).toContain('payInvoice');        // payout_provider

    const settle = adapter.calls.find((c) => c[0] === 'settleHoldInvoice');
    expect(settle[1].preimage).toBe('secret-preimage');

    const pay = adapter.calls.find((c) => c[0] === 'payInvoice');
    expect(pay[1].paymentRequest).toBe('lnbc-provider-payout');
    // full delivery, 10% fee on 10000 -> provider gets 9000
    expect(pay[1].amountSats).toBe(9000);

    const stored = svc.get(escrow.id);
    expect(stored.state).toBe('SETTLED');
    expect((stored.history || []).some((h) => h.event === 'LN_ACTIONS_EXECUTED')).toBe(true);
  });

  it('cancel path: create -> markPaid -> CANCEL cancels the hold invoice (renter refunded via HTLC failure)', async () => {
    const adapter = createMockLnAdapter();
    const svc = createEscrowService({ repository: makeMemRepo(), lnAdapter: adapter });

    const escrow = svc.create({
      orderId: 'order-cancel',
      amountSats: 5000,
      preimage: 'p2',
      preimageHash: 'hash2',
      providerInvoice: 'lnbc-prov2',
    });
    svc.markPaid(escrow.id);        // PENDING -> HELD
    const { event } = svc.cancel(escrow.id); // HELD -> CANCELED (cancel_invoice, refund_renter)
    expect(event).toBe('CANCEL');

    await new Promise((r) => setImmediate(r));

    const names = adapter.calls.map((c) => c[0]);
    expect(names).toContain('cancelHoldInvoice');
    expect(names).not.toContain('payInvoice'); // provider must NOT be paid on a cancel
    const cancel = adapter.calls.find((c) => c[0] === 'cancelHoldInvoice');
    expect(cancel[1].preimageHash).toBe('hash2');
  });

  it('no lnAdapter: transitions still happen but no LN calls fire (backward compatible)', async () => {
    const svc = createEscrowService({ repository: makeMemRepo() }); // no adapter
    const escrow = svc.create({ orderId: 'order-noadapter', amountSats: 3000 });
    svc.markPaid(escrow.id);
    const res = svc.apply(escrow.id, 'DELIVER_OK');
    await new Promise((r) => setImmediate(r));
    expect(res.event).toBe('DELIVER_OK'); // state machine advanced
    expect(svc.get(escrow.id).state).toBe('SETTLED');
  });
});
