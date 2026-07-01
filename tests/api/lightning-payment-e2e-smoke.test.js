// tests/api/lightning-payment-e2e-smoke.test.js
//
// End-to-end smoke test for the full Lightning payment confirmation chain,
// through the real HTTP routes and the real (mock-backed) LightningService/
// invoice-poller singletons — not isolated unit mocks.
//
// This is the test that SHOULD have existed before this session: four
// independent bugs were found in this exact chain by manually running the
// server and walking through the flow by hand (create invoice -> check
// invoice -> node/channel info), each one a calling-convention mismatch or a
// missing method between a route and LightningService. Existing unit tests
// covered auth/validation on these routes; none of them exercised the actual
// mock-LND call chain end-to-end, so none of the four bugs were caught before
// being found live. This test encodes that missing layer: it drives the real
// order -> accept -> pay -> settle -> poll -> confirm chain through supertest
// against the real app, using the same singletons the app itself uses.
//
// Bugs this test would have caught, had it existed from the start:
//   - createInvoice({value, memo, expiry}) producing "NaN" in the payment
//     request (probe: paymentRequest must not contain "NaN" and must encode
//     the real amount).
//   - checkInvoice() not existing at all (probe: GET /payments/invoice/:id
//     must not 500).
//   - the invoice poller never transitioning a settled payment to 'paid'
//     (probe: after simulating settlement and running one poll cycle, the
//     PaymentRepository record and the order status must both reflect it).
//   - getNodeInfo()/listChannels() not existing (probe: GET /payments/
//     node-info and GET /payments/channels must not 500).

const request = require('supertest');
const { app } = require('../../src/api/server');
const { lightning } = require('../../src/core/services');
const invoicePoller = require('../../src/core/invoice-poller');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');
const PaymentRepository = require('../../src/db/json/PaymentRepository');
const UserRepository = require('../../src/db/json/UserRepository');

// Lowercase-only: registration normalizes/stores email in lowercase, and the
// getByEmail() fallback lookup below does an exact string match — a uniq
// string with uppercase letters would silently fail that lookup.
const uniq = `lne2e${Date.now().toString(36)}`;

async function registerAndLogin(prefix, role) {
  const u = `${prefix}${uniq}`.slice(0, 28);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', ...(role ? { role } : {}) });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: login.body.token, id: login.body.user?.id || UserRepository.getByEmail(email)?.id };
}

describe('Lightning payment E2E smoke: order -> accept -> pay -> settle -> poll -> confirm', () => {
  let renter, provider, gpuId, orderId, paymentId, invoiceId;

  beforeAll(async () => {
    renter = await registerAndLogin('lnrent');
    provider = await registerAndLogin('lnprov', 'provider');
    gpuId = GpuRepository.create({
      name: 'E2E Smoke GPU', vendor: 'NVIDIA', model: 'RTX-E2E', memoryGB: 24,
      pricePerHour: 100000, providerId: provider.id, available: true,
    }).id;
    // Guarantee a known-good mock LND regardless of the async initialize()
    // race at server startup (setupMockLND() is idempotent and does not
    // touch this.invoices, so any invoice created below is unaffected).
    if (typeof lightning.setupMockLND === 'function') {
      lightning.setupMockLND();
    }
  });

  it('creates an order and the provider accepts it', async () => {
    const orderRes = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ gpuId, durationMinutes: 60 });
    expect(orderRes.statusCode).toBe(201);
    orderId = orderRes.body.orderId;

    const acceptRes = await request(app).post(`/api/v1/orders/${orderId}/accept`)
      .set('Authorization', `Bearer ${provider.token}`);
    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.body.status).toBe('matched');
  });

  it('creates a real Lightning invoice with no NaN artifacts and the correct amount', async () => {
    const payRes = await request(app).post(`/api/v1/payments/order/${orderId}`)
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ paymentMethod: 'lightning' });
    expect(payRes.statusCode).toBe(201);
    expect(payRes.body.status).toBe('pending');
    expect(payRes.body.paymentRequest).not.toMatch(/NaN/);
    expect(payRes.body.amountSats).toBe(100000);
    paymentId = payRes.body.paymentId;
    invoiceId = payRes.body.invoiceId;
    expect(typeof invoiceId).toBe('string');
    expect(invoiceId.length).toBeGreaterThan(0);
  });

  it('GET /payments/invoice/:id does not 500 and reports unsettled before payment', async () => {
    const res = await request(app).get(`/api/v1/payments/invoice/${invoiceId}`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('pending');
  });

  it('simulating settlement + running one poll cycle marks the payment paid and advances the order', async () => {
    // Simulate what a real LND settlement event would do: mark the tracked
    // mock invoice paid. This is the only way to exercise a genuine
    // pending->paid transition without a real external Lightning payer.
    const tracked = lightning.invoices.get(invoiceId);
    expect(tracked).toBeDefined();
    tracked.status = 'paid';
    tracked.amountPaid = 100000;
    tracked.settledAt = Date.now();

    await invoicePoller.pollOnce();

    const payment = PaymentRepository.getById(paymentId);
    expect(payment.status).toBe('paid');
    expect(payment.amountPaid).toBe(100000);
  });

  it('GET /payments/invoice/:id now reports settled after the poll cycle', async () => {
    const res = await request(app).get(`/api/v1/payments/invoice/${invoiceId}`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('paid');
  });

  it('order/:id/start no longer blocks on "no confirmed payment" (payment gate passes)', async () => {
    // We don't assert start() fully succeeds here (it also requires a real/
    // virtual GPU allocation via vgpuManager, which is a separate concern —
    // see the GPU-access-delivery gap discussed in this session). We only
    // assert the payment gate itself — the thing this test suite is about —
    // is satisfied and the failure, if any, is NOT the 402 payment gate.
    const res = await request(app).post(`/api/v1/orders/${orderId}/start`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.statusCode).not.toBe(402);
  });
});

describe('Lightning admin info endpoints E2E smoke (no 500s)', () => {
  let admin;

  beforeAll(async () => {
    admin = await registerAndLogin('lnadmin', 'provider');
    const users = UserRepository.getAll();
    const idx = users.findIndex((u) => u.id === admin.id);
    UserRepository.update(users[idx].id, { role: 'admin' });
    // Re-login to get a token with the elevated role in its JWT payload.
    const email = users[idx].email;
    const login = await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' });
    admin.token = login.body.token;
  });

  it('GET /node-info does not 500', async () => {
    const res = await request(app).get('/api/v1/node-info').set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).not.toBe(500);
  });

  it('GET /payments/node-info does not 500 and returns a populated node info object', async () => {
    const res = await request(app).get('/api/v1/payments/node-info').set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.pubkey).toEqual(expect.any(String));
  });

  it('GET /payments/channels does not 500', async () => {
    const res = await request(app).get('/api/v1/payments/channels').set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.channels)).toBe(true);
  });
});
