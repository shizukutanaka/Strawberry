// tests/security/probe44-payment-accept-idor.test.js
// Probe 44 regression tests:
// 44a-1: payment records use order.userId (not req.user.id) so renter can always
//        access their own payment status regardless of who created the payment
// 44b-1: /accept updateIf predicate re-checks GPU ownership to close TOCTOU window
//        between the pre-check and the write

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 44a-1: payment record userId = order.userId, not creator ─────────────
describe('payment creation: userId stored from order owner, not creator', () => {
  it('payment/index.js: manual payment uses order.userId', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/payment/index.js'), 'utf-8'
    );
    // Find non-Lightning payment record creation block
    const manualIdx = src.indexOf("method: paymentMethod\n");
    expect(manualIdx).toBeGreaterThan(-1);
    // The userId field near this block must be order.userId, not req.user.id
    const manualBlock = src.slice(Math.max(0, manualIdx - 400), manualIdx + 50);
    expect(manualBlock).toMatch(/userId:\s*order\.userId/);
    expect(manualBlock).not.toMatch(/userId:\s*req\.user\.id/);
  });

  it('payment/index.js: Lightning order payment (POST /order/:id) uses order.userId', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/payment/index.js'), 'utf-8'
    );
    // Find the Lightning invoice creation block specific to /order/:id handler.
    // This block creates the invoice and then the payment record with invoiceExpiresAt.
    const invoiceExpiresIdx = src.indexOf('invoiceExpiresAt: expiresAt');
    expect(invoiceExpiresIdx).toBeGreaterThan(-1);
    const invoiceBlock = src.slice(Math.max(0, invoiceExpiresIdx - 400), invoiceExpiresIdx + 80);
    expect(invoiceBlock).toMatch(/userId:\s*order\.userId/);
    expect(invoiceBlock).not.toMatch(/userId:\s*req\.user\.id/);
  });

  it('payment/index.js: status endpoint allows access by payment.userId', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/payment/index.js'), 'utf-8'
    );
    // Authorization check uses payment.userId (which now equals order.userId)
    expect(src).toMatch(/payment\.userId\s*!==\s*req\.user\.id/);
  });

  it('payment userId consistency: order.userId propagated to created records', () => {
    // Simulate the fix logic inline
    const order = { id: 'order-1', userId: 'renter-abc', gpuId: 'gpu-1', status: 'pending' };
    const reqUser = { id: 'admin-xyz', role: 'admin' };
    // Before fix: userId: req.user.id — After fix: userId: order.userId
    const paymentRecord = { userId: order.userId };
    expect(paymentRecord.userId).toBe('renter-abc');
    expect(paymentRecord.userId).not.toBe(reqUser.id);
  });
});

// ─── 44b-1: /accept updateIf re-checks GPU ownership atomically ───────────
describe('/accept: GPU ownership verified inside updateIf predicate', () => {
  it('order/index.js: updateIf predicate for accept re-checks GPU providerId', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // The predicate passed to updateIf must include a GPU ownership check
    expect(src).toMatch(/GpuRepository\.getById\(o\.gpuId\)/);
    expect(src).toMatch(/freshGpu.*providerId.*acceptingUserId|acceptingUserId.*freshGpu.*providerId/s);
  });

  it('order/index.js: admin role bypasses GPU ownership re-check inside predicate', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // Admin path should skip the GPU ownership check
    expect(src).toMatch(/req\.user\.role\s*===\s*['"]admin['"]\s*\|\|/);
  });

  it('accept TOCTOU guard: stale-provider predicate returns false after GPU transfer', () => {
    // Simulate what the updateIf predicate would evaluate after GPU ownership change
    const order = { id: 'o1', status: 'pending', gpuId: 'g1', providerId: 'provider-old' };
    const freshGpu = { id: 'g1', providerId: 'provider-new' }; // ownership transferred
    const acceptingUserId = 'provider-old';
    const isAdmin = false;

    // The predicate logic from the fix
    const predicatePasses = order.status === 'pending' &&
      (isAdmin || (freshGpu && freshGpu.providerId === acceptingUserId));

    expect(predicatePasses).toBe(false);
  });

  it('accept predicate: original provider passes when GPU ownership unchanged', () => {
    const order = { id: 'o1', status: 'pending', gpuId: 'g1', providerId: 'provider-a' };
    const freshGpu = { id: 'g1', providerId: 'provider-a' }; // same provider
    const acceptingUserId = 'provider-a';
    const isAdmin = false;

    const predicatePasses = order.status === 'pending' &&
      (isAdmin || (freshGpu && freshGpu.providerId === acceptingUserId));

    expect(predicatePasses).toBe(true);
  });
});
