// tests/payments/escrow-audit.test.js
// escrow-service が資金移動イベントを監査ログ（audit DI）へ発行することを検証する。
// 実 appendAuditLog はファイル I/O するため、ここでは捕捉関数を注入する。
const { createEscrowService } = require('../../src/payments/escrow-service');

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
    getByOrderId: (orderId) => [...rows.values()].filter((r) => r.orderId === orderId),
    update: (id, updates) => {
      const cur = rows.get(id);
      if (!cur) return null;
      const next = { ...cur, ...updates };
      rows.set(id, next);
      return next;
    },
    updateIf: (id, pred, updates) => {
      const cur = rows.get(id);
      if (!cur || !pred(cur)) return { ok: false, row: cur || null };
      const next = { ...cur, ...updates };
      rows.set(id, next);
      return { ok: true, row: next };
    },
    _rows: rows,
  };
}

function svc() {
  const events = [];
  const audit = (action, detail) => events.push({ action, detail });
  const s = createEscrowService({ repository: makeMemoryRepo(), audit });
  return { s, events };
}

describe('escrow-service audit logging', () => {
  it('logs escrow_created with amounts on create', () => {
    const { s, events } = svc();
    const e = s.create({ orderId: 'order-1', amountSats: 5000, feeRate: 0.02 });
    const created = events.find((x) => x.action === 'escrow_created');
    expect(created).toBeDefined();
    expect(created.detail).toMatchObject({
      escrowId: e.id, orderId: 'order-1', amountSats: 5000, feeRate: 0.02,
    });
  });

  it('logs escrow_transition with from/to on each state change', () => {
    const { s, events } = svc();
    const e = s.create({ orderId: 'order-1', amountSats: 5000 });
    s.markPaid(e.id);
    s.apply(e.id, 'DELIVER_OK');
    const transitions = events.filter((x) => x.action === 'escrow_transition');
    expect(transitions.map((t) => [t.detail.from, t.detail.to])).toEqual([
      ['PENDING', 'HELD'],
      ['HELD', 'SETTLED'],
    ]);
    expect(transitions[0].detail.escrowId).toBe(e.id);
    expect(transitions[0].detail.orderId).toBe('order-1');
  });

  it('logs escrow_create_rejected when a duplicate escrow is attempted', () => {
    const { s, events } = svc();
    const e = s.create({ orderId: 'order-1', amountSats: 1000 });
    expect(() => s.create({ orderId: 'order-1', amountSats: 2000 }))
      .toThrow(/already exists/);
    const rejected = events.find((x) => x.action === 'escrow_create_rejected');
    expect(rejected).toBeDefined();
    expect(rejected.detail).toMatchObject({
      orderId: 'order-1', existingEscrowId: e.id, existingState: 'PENDING',
    });
  });

  it('logs escrow_settlement_computed with the payout breakdown', () => {
    const { s, events } = svc();
    const e = s.create({ orderId: 'order-1', amountSats: 10000, feeRate: 0.1 });
    s.markPaid(e.id);
    s.settle(e.id, { deliveredRatio: 1, slaUptimePct: 100 });
    const settled = events.find((x) => x.action === 'escrow_settlement_computed');
    expect(settled).toBeDefined();
    expect(settled.detail).toMatchObject({
      escrowId: e.id, orderId: 'order-1', providerPayoutSats: 9000,
      renterRefundSats: 0, operatorFeeSats: 1000, chargedSats: 10000,
    });
  });

  it('logs escrow_ln_actions_failed when the LN adapter throws', async () => {
    const events = [];
    const s = createEscrowService({
      repository: makeMemoryRepo(),
      audit: (action, detail) => events.push({ action, detail }),
      lnAdapter: {
        settleHoldInvoice: () => Promise.reject(new Error('lnd unreachable')),
        cancelHoldInvoice: () => Promise.reject(new Error('lnd unreachable')),
        payInvoice: () => Promise.reject(new Error('lnd unreachable')),
      },
    });
    const e = s.create({ orderId: 'order-1', amountSats: 1000 });
    s.markPaid(e.id);
    // HELD + CANCEL → cancel_invoice が adapter.cancelHoldInvoice を呼び reject される。
    // runActions は fire-and-forget のため 1 ティック待つ。
    s.apply(e.id, 'CANCEL');
    await new Promise((r) => setImmediate(r));
    const failed = events.find((x) => x.action === 'escrow_ln_actions_failed');
    expect(failed).toBeDefined();
    expect(failed.detail).toMatchObject({
      escrowId: e.id, orderId: 'order-1', error: 'lnd unreachable',
    });
    expect(failed.detail.actions).toContain('cancel_invoice');
  });

  it('logs escrow_transition_conflict when CAS write loses the race', () => {
    const events = [];
    const repo = makeMemoryRepo();
    // updateIf が常に CAS 失敗するリポジトリを差し込む
    repo.updateIf = (id, pred, updates) => ({ ok: false, row: repo.getById(id) });
    const s = createEscrowService({
      repository: repo,
      audit: (action, detail) => events.push({ action, detail }),
    });
    const e = s.create({ orderId: 'order-1', amountSats: 1000 });
    expect(() => s.markPaid(e.id)).toThrow(/concurrently/);
    const conflict = events.find((x) => x.action === 'escrow_transition_conflict');
    expect(conflict).toBeDefined();
    expect(conflict.detail).toMatchObject({
      escrowId: e.id, orderId: 'order-1', event: 'PAY', expectedState: 'PENDING',
    });
  });
});
