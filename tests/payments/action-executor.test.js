// tests/payments/action-executor.test.js
const { executeActions } = require('../../src/payments/action-executor');
const { createMockLnAdapter } = require('../../src/payments/ln-adapter');
const { transition, STATES } = require('../../src/payments/escrow-state-machine');

const ctx = { preimage: 'pre-1', preimageHash: 'hash-1', providerInvoice: 'lnbc-prov', payoutSats: 985 };

describe('action-executor', () => {
  it('maps settle actions to LN settle + payout', async () => {
    const adapter = createMockLnAdapter();
    const res = await executeActions(['reveal_preimage', 'payout_provider', 'collect_fee'], ctx, adapter);
    const names = adapter.calls.map((c) => c[0]);
    expect(names).toEqual(['settleHoldInvoice', 'payInvoice']);
    expect(res.find((r) => r.action === 'reveal_preimage').kind).toBe('ln');
    expect(res.find((r) => r.action === 'collect_fee').kind).toBe('domain');
  });

  it('maps cancel to LN cancel; refund_renter is implicit (domain noop)', async () => {
    const adapter = createMockLnAdapter();
    const res = await executeActions(['cancel_invoice', 'refund_renter'], ctx, adapter);
    expect(adapter.calls.map((c) => c[0])).toEqual(['cancelHoldInvoice']);
    expect(res.find((r) => r.action === 'refund_renter').kind).toBe('domain');
  });

  it('domain-only actions trigger no LN calls', async () => {
    const adapter = createMockLnAdapter();
    await executeActions(['open_dispute', 'slash_provider', 'hold_preimage'], ctx, adapter);
    expect(adapter.calls).toHaveLength(0);
  });

  it('flags unknown actions as skipped', async () => {
    const adapter = createMockLnAdapter();
    const res = await executeActions(['frobnicate'], ctx, adapter);
    expect(res[0].kind).toBe('unknown');
  });

  it('validates inputs', async () => {
    await expect(executeActions('nope', ctx, createMockLnAdapter())).rejects.toThrow(/array/);
    await expect(executeActions(['reveal_preimage'], ctx, null)).rejects.toThrow(/adapter/);
  });

  it('executes the actual FSM settle actions end-to-end', async () => {
    const adapter = createMockLnAdapter();
    // PENDING -> HELD -> SETTLED, then run the settle actions through the adapter
    const settled = transition(STATES.HELD, 'DELIVER_OK');
    expect(settled.state).toBe(STATES.SETTLED);
    await executeActions(settled.actions, ctx, adapter);
    expect(adapter.calls.map((c) => c[0])).toContain('settleHoldInvoice');
    expect(adapter.calls.map((c) => c[0])).toContain('payInvoice');
  });

  it('mock adapter can create a hold invoice', async () => {
    const adapter = createMockLnAdapter();
    const inv = await adapter.createHoldInvoice({ amountSats: 1000, preimageHash: 'h' });
    expect(inv.paymentRequest).toMatch(/^lnbc-mock-/);
    expect(inv.amountSats).toBe(1000);
  });
});
