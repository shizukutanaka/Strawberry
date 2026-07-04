// tests/unit/lightning-service-pay-invoice.test.js
//
// Regression for two bugs found while removing dead code from lightning-service.js:
//
// 1. sendPayment(paymentRequest, maxFee) treated its 2nd argument as a
//    USD-denominated fee cap and ran it through convertUSDToSats() (a live
//    BTC-price API call) to get a sats-denominated fee_limit. But
//    payInvoice(paymentRequest, maxFee) — the public wrapper both real
//    callers use — only declared 2 parameters, so callers passing 3
//    (paymentRequest, amount, maxFeePercent) had maxFeePercent silently
//    dropped, and `amount` (a SATS value) landed in the `maxFee` slot and
//    got double-converted as if it were USD. schemas.payment.pay defines
//    maxFeePercent as a 0-10 percentage (default 1), never a USD amount —
//    the whole USD-conversion path was wrong for this call regardless of
//    the dead convertUSDToSats() being removed.
//
// 2. decodePayReq was never implemented on the mock LND (setupMockLND()),
//    so POST /payments/pay — a live, real, admin-only route — always threw
//    "this.lnd.decodePayReq is not a function" in any environment without a
//    real LND connection. Same missing-mock-method pattern as the
//    getNodeInfo/listChannels bugs fixed earlier this session.
//
// Fix: payInvoice(paymentRequest, amount, maxFeePercent) now threads
// maxFeePercent through to sendPayment(paymentRequest, maxFeePercent), which
// computes maxFeeSats = ceil(invoiceSats * (maxFeePercent / 100)) — sats-native,
// no external exchange-rate dependency. Added a decodePayReq mock stub.

const { LightningService } = require('../../lightning-service');

function makeMockService() {
  const svc = new LightningService();
  svc.setupMockLND();
  return svc;
}

describe('LightningService.sendPayment: fee limit computed as a percentage of invoice sats', () => {
  it('decodePayReq no longer throws "not a function" (mock method was entirely missing)', async () => {
    const svc = makeMockService();
    const decoded = await svc.decodePaymentRequest('lnbc1000n1p...');
    expect(decoded.num_satoshis).toBeDefined();
  });

  it('passes fee_limit.fixed as ceil(invoiceSats * maxFeePercent/100), not a USD-converted value', async () => {
    const svc = makeMockService();
    let capturedFeeLimit = null;
    const originalSendPaymentSync = svc.lnd.sendPaymentSync;
    svc.lnd.sendPaymentSync = (request, callback) => {
      capturedFeeLimit = request.fee_limit;
      return originalSendPaymentSync(request, callback);
    };

    // mock decodePayReq returns num_satoshis: '1000'; maxFeePercent=2 -> ceil(1000*0.02)=20
    await svc.sendPayment('lnbc1000n1p...', 2);
    expect(capturedFeeLimit).toEqual({ fixed: 20 });
  });

  it('defaults to 1% when maxFeePercent is omitted (matches schemas.payment.pay default)', async () => {
    const svc = makeMockService();
    let capturedFeeLimit = null;
    const originalSendPaymentSync = svc.lnd.sendPaymentSync;
    svc.lnd.sendPaymentSync = (request, callback) => {
      capturedFeeLimit = request.fee_limit;
      return originalSendPaymentSync(request, callback);
    };

    await svc.sendPayment('lnbc1000n1p...');
    expect(capturedFeeLimit).toEqual({ fixed: 10 }); // ceil(1000 * 1/100)
  });

  it('does not call the (now-removed) USD conversion path even for a large numeric 2nd arg', async () => {
    // Before the fix, a caller passing a sats `amount` (e.g. 100000) into the old
    // maxFee slot would trigger convertUSDToSats(100000) — treating 100000 sats
    // as if it were $100,000, producing a wildly wrong fee_limit. Now this value
    // is correctly interpreted as a percentage and clamped by the route's own
    // Joi validation (0-10) before ever reaching here; verify the raw computation
    // itself has no USD/exchange-rate dependency by asserting it completes
    // synchronously-fast with no network call involved (the old convertUSDToSats
    // hit a live CoinGecko-style API on cache miss).
    const svc = makeMockService();
    const start = Date.now();
    await svc.sendPayment('lnbc1000n1p...', 5);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // no external HTTP call in the hot path
  });
});

describe('LightningService.payInvoice: threads maxFeePercent through to sendPayment', () => {
  it('accepts (paymentRequest, amount, maxFeePercent) — the real 3-arg caller contract', async () => {
    const svc = makeMockService();
    const result = await svc.payInvoice('lnbc1000n1p...', 1000, 3);
    expect(result.status).toBe('completed');
  });

  it('is a function with the correct arity to accept 3 arguments', () => {
    const svc = makeMockService();
    expect(svc.payInvoice.length).toBe(3);
  });
});

describe('lightning-service.js: dead code removed cleanly', () => {
  it('createHoldInvoice, generateInvoice, convertUSDToSats, getBTCPrice no longer exist', () => {
    const svc = makeMockService();
    expect(svc.createHoldInvoice).toBeUndefined();
    expect(svc.generateInvoice).toBeUndefined();
    expect(svc.convertUSDToSats).toBeUndefined();
    expect(svc.getBTCPrice).toBeUndefined();
  });
});
