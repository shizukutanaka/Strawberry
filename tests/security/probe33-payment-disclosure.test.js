// tests/security/probe33-payment-disclosure.test.js
// Probe 33 regression tests:
// 1. settle() CAS uses && not || (no re-settlement on SETTLED escrow with missing settlement)
// 2. POST /register no longer leaks apiKey (uses sanitizeUser())
// 3. btc-onchain.js has explicit authenticateJWT middleware
// 4. GET /orders does not expose review.reviewerId to counterparties
// 5. settle() idempotent: second call blocked when settlement already written

const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');

const uniq = `p33${Date.now().toString(36)}`;
let userTok, userId, providerId, gpuId, providerTok;

beforeAll(async () => {
  const usrName = `p33usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  const regRes = await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  userId = regRes.body.user?.id;
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;

  const prvName = `p33prv${uniq}`.slice(0, 20);
  const prvEmail = `${prvName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: prvName, email: prvEmail, password: 'Test1234!' });
  const prv = UserRepository.getByEmail(prvEmail);
  providerId = prv.id;
  UserRepository.update(providerId, { role: 'provider' });
  providerTok = (await request(app).post('/api/v1/users/login')
    .send({ email: prvEmail, password: 'Test1234!' })).body.token;

  const gpu = GpuRepository.create({
    name: 'P33 Test GPU', vendor: 'NVIDIA', model: 'RTX-P33', memoryGB: 8,
    pricePerHour: 100, providerId,
  });
  gpuId = gpu.id;
});

afterAll(() => {
  try { GpuRepository.delete(gpuId); } catch (_) {}
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 1. settle() CAS uses && not || ──────────────────────────────────────────
describe('settle() CAS predicate uses && not ||', () => {
  it('escrow-service.js: settle() CAS predicate is && not ||', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/payments/escrow-service.js'), 'utf-8'
    );
    // Must use && (not ||) so that SETTLED escrow with missing settlement is blocked
    expect(src).toMatch(/\.includes\(e\.state\)\s*&&\s*!e\.settlement/);
    // Must NOT use the vulnerable || version
    expect(src).not.toMatch(/\.includes\(e\.state\)\s*\|\|\s*!e\.settlement/);
  });

  it('settle() is idempotent: second call with same escrow is blocked', () => {
    const { createEscrowService } = require('../../src/payments/escrow-service');
    const records = {};
    const mockRepo = {
      getById: (id) => records[id] || null,
      create: (data) => { const rec = { ...data, id: `esc-${Date.now()}`, state: 'PENDING', history: [] }; records[rec.id] = rec; return rec; },
      update: (id, data) => { records[id] = { ...records[id], ...data }; return records[id]; },
      updateIf: (id, pred, data) => {
        const rec = records[id];
        if (!rec || !pred(rec)) return { ok: false, current: rec };
        records[id] = { ...rec, ...data };
        return { ok: true, row: records[id] };
      },
      getByOrderId: (orderId) => Object.values(records).filter(e => e.orderId === orderId),
    };
    const svc = createEscrowService({ repository: mockRepo });
    const e = svc.create({ orderId: 'order-p33', amountSats: 1000 });
    svc.apply(e.id, 'PAY'); // PENDING → HELD

    // First settle: should succeed (HELD and no settlement)
    expect(() => svc.settle(e.id, { deliveredRatio: 1, slaUptimePct: 100 })).not.toThrow();

    // Second settle: should throw because settlement already written (even though still HELD)
    expect(() => svc.settle(e.id, { deliveredRatio: 0.5, slaUptimePct: 50 })).toThrow(/concurrent/i);
  });
});

// ─── 2. POST /register: apiKey not leaked ────────────────────────────────────
describe('POST /register: no apiKey in response', () => {
  it('registration response does not include apiKey or password', async () => {
    const name = `p33reg${uniq}`.slice(0, 20);
    const email = `${name}@example.com`;
    const res = await request(app).post('/api/v1/users/register')
      .send({ username: name, email, password: 'Test1234!' });
    expect(res.statusCode).toBe(201);
    expect(res.body.user).toBeDefined();
    // Must not expose apiKey
    expect(res.body.user.apiKey).toBeUndefined();
    // Must not expose password hash
    expect(res.body.user.password).toBeUndefined();
  });
});

// ─── 3. btc-onchain: explicit authenticateJWT ────────────────────────────────
describe('btc-onchain.js: route-level auth guard', () => {
  it('POST /payment/btc without token returns 401', async () => {
    const res = await request(app)
      .post('/api/v1/payment/btc')
      .send({ orderId: 'fake-order-id', borrowerWallet: 'bc1qfakeaddress' });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('btc-onchain.js source has explicit authenticateJWT on POST route', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/payment/btc-onchain.js'), 'utf-8'
    );
    expect(src).toMatch(/router\.post\(['"]\/['"]\s*,\s*authenticateJWT/);
  });
});

// ─── 4. GET /orders: reviewerId stripped ────────────────────────────────────
describe('GET /orders: review.reviewerId is not exposed', () => {
  it('order listing does not include review.reviewerId in responses', async () => {
    const res = await request(app)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${userTok}`);
    expect(res.statusCode).toBe(200);
    const orders = res.body.orders || [];
    for (const order of orders) {
      if (order.review) {
        expect(order.review.reviewerId).toBeUndefined();
      }
      if (order.renterReview) {
        expect(order.renterReview.reviewerId).toBeUndefined();
      }
    }
  });
});
