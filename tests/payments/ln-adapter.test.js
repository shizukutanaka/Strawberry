// src/payments/ln-adapter.js — MockLnAdapter のインターフェース契約を固定するテスト。
// §6 の LN 実機結線では実装がこの IF に準拠する前提のため、Mock の戻り値形状・
// 呼出履歴・採番が実機アダプタの仕様検定として機能する。
const { createMockLnAdapter } = require('../../src/payments/ln-adapter');

describe('createMockLnAdapter', () => {
  it('creates hold invoices with request/hash/amount and records the call', async () => {
    const ln = createMockLnAdapter();
    const res = await ln.createHoldInvoice({ amountSats: 1000, preimageHash: 'h1', memo: 'm', expiry: 3600 });
    expect(res).toEqual({ paymentRequest: 'lnbc-mock-1', preimageHash: 'h1', amountSats: 1000 });
    expect(ln.calls).toEqual([['createHoldInvoice', { amountSats: 1000, preimageHash: 'h1', memo: 'm', expiry: 3600 }]]);
  });

  it('generates a preimage hash when none is supplied', async () => {
    const ln = createMockLnAdapter();
    const res = await ln.createHoldInvoice({ amountSats: 1 });
    expect(res.preimageHash).toBe('hash-1');
  });

  it('settle/cancel/pay/getInfo match the documented interface', async () => {
    const ln = createMockLnAdapter();
    await expect(ln.settleHoldInvoice('pre')).resolves.toEqual({ settled: true, preimage: 'pre' });
    await expect(ln.cancelHoldInvoice('h')).resolves.toEqual({ canceled: true, preimageHash: 'h' });
    const pay = await ln.payInvoice('lnbc1x', 500);
    expect(pay).toMatchObject({ paid: true, paymentRequest: 'lnbc1x', amountSats: 500 });
    expect(pay.txid).toBe('mock-tx-1');
    await expect(ln.getInfo()).resolves.toMatchObject({ mock: true });
  });

  it('increments the sequence across invoice and payment calls', async () => {
    const ln = createMockLnAdapter();
    const a = await ln.createHoldInvoice({ amountSats: 1 });
    const p = await ln.payInvoice('lnbc', 1);
    const b = await ln.createHoldInvoice({ amountSats: 2 });
    expect(a.paymentRequest).toBe('lnbc-mock-1');
    expect(p.txid).toBe('mock-tx-2');
    expect(b.paymentRequest).toBe('lnbc-mock-3');
  });

  it('keeps independent call histories per adapter instance', async () => {
    const a = createMockLnAdapter();
    const b = createMockLnAdapter();
    await a.createHoldInvoice({ amountSats: 1 });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });
});
