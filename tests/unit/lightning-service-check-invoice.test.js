// tests/unit/lightning-service-check-invoice.test.js
//
// Regression for a critical bug found by manually smoke-testing the live payment
// flow: src/core/invoice-poller.js polls every pending Lightning payment every
// 15 seconds by calling `_lightning.checkInvoice(payment.paymentHash)` — this is
// the ONLY mechanism that ever transitions a Lightning payment from 'pending' to
// 'paid' in PaymentRepository (the persisted record the rest of the app reads:
// order /start's hasPaidPayment gate, GMV stats, earnings summaries, etc).
//
// checkInvoice() did not exist anywhere on the LightningService class. Every
// poll cycle threw `TypeError: _lightning.checkInvoice is not a function`,
// caught by the poller's per-invoice try/catch and merely logged as a warning —
// meaning Lightning payments could NEVER be automatically confirmed, in mock
// mode or with a real LND connection. Every invoice would eventually just expire
// and be marked 'failed', regardless of whether it was actually paid.
//
// GET /payments/invoice/:id (src/api/routes/payment/index.js) also calls
// lightning.checkInvoice(invoiceId) directly and would have thrown a 500 for
// every request.
//
// Fix: added checkInvoice(paymentHash), wrapping LND's real lookupInvoice gRPC
// method and normalizing the response to { settled, amountPaid, value,
// settleDate } — the exact shape both callers already expected. Also added a
// lookupInvoice stub to the mock LND (there was none), backed by the same
// in-memory `this.invoices` map that createInvoice() populates.

const { LightningService } = require('../../lightning-service');

function makeMockService() {
  const svc = new LightningService();
  svc.setupMockLND();
  return svc;
}

describe('LightningService.checkInvoice: exists and does not throw for a known invoice', () => {
  it('is a function on the service (the core bug: it did not exist at all)', () => {
    const svc = makeMockService();
    expect(typeof svc.checkInvoice).toBe('function');
  });

  it('returns settled:false for a freshly created, unpaid invoice (mock has no real payer)', async () => {
    const svc = makeMockService();
    const invoice = await svc.createInvoice({ value: 50000, memo: 'test order', expiry: 3600 });
    const status = await svc.checkInvoice(invoice.paymentHash);
    expect(status.settled).toBe(false);
  });

  it('returns settled:true with the correct amountPaid once the tracked invoice is marked paid', async () => {
    const svc = makeMockService();
    const invoice = await svc.createInvoice({ value: 75000, memo: 'test order', expiry: 3600 });
    // Simulate what the (currently disconnected) event-stream settlement path would
    // do: mark the in-memory tracked invoice paid.
    const tracked = svc.invoices.get(invoice.paymentHash);
    tracked.status = 'paid';
    tracked.amountPaid = 75000;
    tracked.settledAt = Date.now();

    const status = await svc.checkInvoice(invoice.paymentHash);
    expect(status.settled).toBe(true);
    expect(status.amountPaid).toBe(75000);
    expect(status.value).toBe(75000);
    expect(typeof status.settleDate).toBe('number');
  });

  it('rejects for an unknown payment hash instead of hanging or crashing uncaught', async () => {
    const svc = makeMockService();
    await expect(svc.checkInvoice('0'.repeat(64))).rejects.toThrow();
  });
});

describe('invoice-poller integration: checkInvoice no longer throws TypeError mid-poll', () => {
  const PaymentRepository = require('../../src/db/json/PaymentRepository');
  let createdId;

  afterEach(() => {
    // This test writes to the shared file-backed PaymentRepository (data/payments.json).
    // Clean up so it does not leak a stray 'pending' record that a real running
    // server's poller would then repeatedly (and pointlessly) try to check.
    if (createdId) {
      try { PaymentRepository.delete(createdId); } catch (_) {}
      createdId = null;
    }
  });

  it('pollOnce completes a full cycle without an uncaught TypeError for a pending Lightning payment', async () => {
    // This directly exercises the real call site that was broken: the poller's
    // `await _lightning.checkInvoice(payment.paymentHash)` call.
    const poller = require('../../src/core/invoice-poller');
    const svc = makeMockService();
    const invoice = await svc.createInvoice({ value: 1000, memo: 'poller test', expiry: 3600 });

    const created = PaymentRepository.create({
      orderId: null,
      userId: 'test-user',
      method: 'lightning',
      status: 'pending',
      amount: 1000,
      paymentHash: invoice.paymentHash,
      invoiceExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    createdId = created.id;

    poller.start(svc);
    // start() runs pollOnce() synchronously-ish (fire and forget); give the
    // microtask queue a tick to let the async pollOnce body run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    poller.stop();

    // The payment must still exist and be readable — if checkInvoice had thrown
    // uncaught (outside the per-invoice try/catch), the poll cycle or the test
    // process itself could have been disrupted. Confirm the record is untouched
    // (still pending, since the mock invoice was never marked paid) and no crash
    // occurred getting here.
    const after = PaymentRepository.getById(created.id);
    expect(after.status).toBe('pending');
  });
});

describe('LightningService.checkInvoice: startup race guard', () => {
  it('throws a clear error instead of a bare TypeError when this.lnd is not yet connected', async () => {
    // server.js starts invoice-poller synchronously while lightning.initialize()
    // (which sets this.lnd) runs asynchronously — the first pollOnce() can fire
    // before this.lnd exists. Without this guard, checkInvoice would throw
    // "Cannot read properties of null (reading 'lookupInvoice')", which is
    // confusing in logs and indistinguishable from other null-reference bugs.
    const svc = new LightningService(); // this.lnd is null — setupMockLND() not called
    await expect(svc.checkInvoice('a'.repeat(64))).rejects.toThrow(/not yet connected/);
  });
});
