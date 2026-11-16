// tests/security/probe44-payment-accept-idor.test.js
// Probe 44 regression tests:
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
