// tests/payments/escrow-service-ln-wiring.test.js
// escrow-service に action-executor + ln-adapter を配線した後の回帰・新規テスト。
//
// 背景: escrow-state-machine の遷移が返す actions（reveal_preimage/payout_provider/
// cancel_invoice 等）は、これまで escrow-service のどの呼び出し元からも
// action-executor.executeActions() へ渡されていなかった — 資金移動の「意図」を
// 計算するだけで実行する経路が存在しない、というエスクローとして致命的なギャップ
// だった（tests/payments/escrow-service.test.js の既存テストは repository/state 遷移
// のみを検証し、この欠落を検出できていなかった）。
// 本テストは (a) lnAdapter 未指定時に既存呼び出し側の挙動が一切変わらないこと、
// (b) lnAdapter 指定時に実際に settleHoldInvoice/payInvoice/cancelHoldInvoice が
// 正しい ctx（preimage/preimageHash/providerInvoice/payoutSats）で呼ばれること、
// (c) LN 実行が失敗しても状態遷移自体は成功したままであること、を確認する。
const { createEscrowService } = require('../../src/payments/escrow-service');
const { createMockLnAdapter } = require('../../src/payments/ln-adapter');
const { STATES } = require('../../src/payments/escrow-state-machine');

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

// runActions は apply()/evaluate() から fire-and-forget で呼ばれる（同期戻り値の
// 契約を壊さないため）。実行完了を待つには1マイクロタスク+1マクロタスク分ずらす。
function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('escrow-service: LN action execution wiring', () => {
  it('without lnAdapter: behaves exactly as before (no LN calls, no extra history)', async () => {
    const repo = makeMemoryRepo();
    const s = createEscrowService({ repository: repo });
    const e = s.create({ orderId: 'o1', amountSats: 1000 });
    s.markPaid(e.id);
    const { escrow, event } = s.evaluate(e.id, { verified: true });
    await flushAsync();
    expect(event).toBe('DELIVER_OK');
    expect(escrow.state).toBe(STATES.SETTLED);
    // no LN_ACTIONS_EXECUTED/FAILED entries appended
    expect(escrow.history.map((h) => h.event)).toEqual(['PAY', 'DELIVER_OK']);
  });

  it('with lnAdapter: DELIVER_OK executes settleHoldInvoice + payInvoice with correct ctx', async () => {
    const repo = makeMemoryRepo();
    const adapter = createMockLnAdapter();
    const s = createEscrowService({ repository: repo, lnAdapter: adapter });
    const e = s.create({ orderId: 'o2', amountSats: 10000, feeRate: 0.02 });
    // simulate a hold invoice already opened elsewhere: populate preimage/hash/providerInvoice
    repo.update(e.id, { preimage: 'pre-abc', preimageHash: 'hash-abc', providerInvoice: 'lnbc-provider-inv' });
    s.markPaid(e.id);
    s.settle(e.id, { deliveredRatio: 1, slaUptimePct: 100 });
    const before = s.get(e.id);
    const payoutSats = before.settlement.providerPayoutSats;
    s.evaluate(e.id, { verified: true });
    await flushAsync();

    const names = adapter.calls.map((c) => c[0]);
    expect(names).toEqual(['settleHoldInvoice', 'payInvoice']);
    expect(adapter.calls[0][1]).toEqual({ preimage: 'pre-abc' });
    expect(adapter.calls[1][1]).toEqual({ paymentRequest: 'lnbc-provider-inv', amountSats: payoutSats });

    const final = s.get(e.id);
    expect(final.history.map((h) => h.event)).toContain('LN_ACTIONS_EXECUTED');
  });

  it('with lnAdapter: CANCEL executes cancelHoldInvoice', async () => {
    const repo = makeMemoryRepo();
    const adapter = createMockLnAdapter();
    const s = createEscrowService({ repository: repo, lnAdapter: adapter });
    const e = s.create({ orderId: 'o3', amountSats: 500 });
    repo.update(e.id, { preimageHash: 'hash-cancel' });
    s.markPaid(e.id);
    s.cancel(e.id);
    await flushAsync();

    expect(adapter.calls.map((c) => c[0])).toEqual(['cancelHoldInvoice']);
    expect(adapter.calls[0][1]).toEqual({ preimageHash: 'hash-cancel' });
  });

  it('LN execution failure is recorded but does not undo the already-persisted state transition', async () => {
    const repo = makeMemoryRepo();
    const adapter = createMockLnAdapter();
    adapter.settleHoldInvoice = async () => { throw new Error('mock LN failure'); };
    const s = createEscrowService({ repository: repo, lnAdapter: adapter });
    const e = s.create({ orderId: 'o4', amountSats: 100 });
    repo.update(e.id, { preimage: 'p', providerInvoice: 'lnbc-x' });
    s.markPaid(e.id);
    const { escrow, event } = s.evaluate(e.id, { verified: true });
    await flushAsync();

    // state transition already succeeded synchronously before the async LN call ran
    expect(event).toBe('DELIVER_OK');
    expect(escrow.state).toBe(STATES.SETTLED);

    const final = s.get(e.id);
    expect(final.state).toBe(STATES.SETTLED); // not rolled back
    expect(final.history.map((h) => h.event)).toContain('LN_ACTIONS_FAILED');
  });
});
