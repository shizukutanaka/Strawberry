// tests/unit/lightning-service-create-invoice.test.js
//
// Regression for a severe bug found by manually smoke-testing the live payment
// flow end-to-end (register → GPU → order → payment), not by static review.
//
// createInvoice() had two stacked defects:
//
// 1. Calling-convention mismatch: every real caller (src/api/routes/payment/index.js,
//    both the admin /invoice endpoint and the per-order /payments/order/:id endpoint)
//    invokes `lightning.createInvoice({ value, memo, expiry })` — a single object.
//    But the function was defined as `createInvoice(amount, memo)`, expecting two
//    positional arguments. Passing an object as `amount` meant `amount` was an
//    object, not a number, and `memo` was always undefined.
//
// 2. Wrong unit semantics: the function additionally treated its numeric input as
//    US dollars and ran it through convertUSDToSats() (a live BTC-price API call).
//    Every real caller already computes `value` in satoshis (order-pricing.js is
//    sats-native throughout) — so even with the calling convention fixed, treating
//    an already-in-sats value as USD would have produced a wildly wrong amount in
//    the other direction.
//
// Combined, calling `object / number` in convertUSDToSats produced NaN, which was
// then string-concatenated directly into the mock BOLT11 invoice string
// ('lnbc' + request.value + '1' + ...), producing a literally malformed invoice
// like "lnbcNaN17mX..." — confirmed live against the running server.
//
// Fix: createInvoice now accepts { value, memo, expiry } where value is satoshis
// (matching every real caller and LND's actual AddInvoice contract, which takes
// satoshis natively — no USD conversion is needed or was ever correct here).

const { LightningService } = require('../../lightning-service');

function makeMockService() {
  const svc = new LightningService();
  svc.setupMockLND();
  return svc;
}

describe('LightningService.createInvoice: accepts {value, memo, expiry} in satoshis', () => {
  it('produces a payment request with no NaN artifacts for a realistic sats amount', async () => {
    const svc = makeMockService();
    const invoice = await svc.createInvoice({ value: 100000, memo: 'GPU rental order abc123', expiry: 3600 });
    expect(invoice.paymentRequest).not.toMatch(/NaN/);
    expect(invoice.amountSats).toBe(100000);
  });

  it('embeds the exact satoshi amount in the invoice value sent to LND (no USD conversion)', async () => {
    const svc = makeMockService();
    const invoice = await svc.createInvoice({ value: 42, memo: 'small order', expiry: 3600 });
    // The mock addInvoice builds 'lnbc' + request.value + '1' + ... — assert the
    // literal sats value (42) appears where the amount belongs, not a converted
    // USD->sats value or NaN.
    expect(invoice.paymentRequest).toMatch(/^lnbc42\b|^lnbc421/); // '42' followed by the '1' separator
    expect(invoice.amountSats).toBe(42);
  });

  it('returns an `id` field (paymentHash) for API-contract compatibility with callers', () => {
    return makeMockService().createInvoice({ value: 1000, memo: 'x', expiry: 3600 }).then((invoice) => {
      expect(typeof invoice.id).toBe('string');
      expect(invoice.id).toBe(invoice.paymentHash);
      expect(invoice.id.length).toBeGreaterThan(0);
    });
  });

  it('respects the caller-provided expiry instead of hardcoding 3600s', async () => {
    const svc = makeMockService();
    const before = Date.now();
    const invoice = await svc.createInvoice({ value: 1000, memo: 'x', expiry: 60 });
    const expectedExpiry = before + 60 * 1000;
    // Allow a small tolerance for test execution time.
    expect(invoice.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 2000);
    expect(invoice.expiresAt).toBeLessThanOrEqual(expectedExpiry + 2000);
  });

  it('falls back to a 3600s expiry when none is provided', async () => {
    const svc = makeMockService();
    const before = Date.now();
    const invoice = await svc.createInvoice({ value: 1000, memo: 'x' });
    expect(invoice.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 2000);
  });

  it('rejects a missing or non-positive value instead of silently producing NaN', async () => {
    const svc = makeMockService();
    await expect(svc.createInvoice({ memo: 'no value' })).rejects.toThrow(/positive finite number/);
    await expect(svc.createInvoice({ value: 0, memo: 'zero' })).rejects.toThrow(/positive finite number/);
    await expect(svc.createInvoice({ value: -5, memo: 'negative' })).rejects.toThrow(/positive finite number/);
    await expect(svc.createInvoice({ value: NaN, memo: 'nan' })).rejects.toThrow(/positive finite number/);
  });

  it('stores the invoice in the internal map keyed by paymentHash (for later settlement lookup)', async () => {
    const svc = makeMockService();
    const invoice = await svc.createInvoice({ value: 5000, memo: 'lookup test', expiry: 3600 });
    expect(svc.invoices.get(invoice.paymentHash)).toBe(invoice);
  });
});
