// tests/security/probe33-payment-disclosure.test.js
// Probe 33 regression tests:
// 1. (removed 2026-09 — escrow-service.js and its settle() CAS guard no longer exist;
//    hold-invoice escrow was deleted, see ARCHITECTURE.md「エスクロー機構の削除」節)
// 2. POST /register no longer leaks apiKey (uses sanitizeUser())
// 3. (removed 2026-09 — the btc-onchain route it guarded no longer exists)
// 4. GET /orders does not expose review.reviewerId to counterparties
// 5. (removed 2026-09 — escrow settle() idempotency no longer applicable, see 1)

const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');

const uniq = `p33${Date.now().toString(36)}`;
let userTok, _userId, providerId, gpuId, _providerTok;

beforeAll(async () => {
  const usrName = `p33usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  const regRes = await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  _userId = regRes.body.user?.id;
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;

  const prvName = `p33prv${uniq}`.slice(0, 20);
  const prvEmail = `${prvName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: prvName, email: prvEmail, password: 'Test1234!' });
  const prv = UserRepository.getByEmail(prvEmail);
  providerId = prv.id;
  UserRepository.update(providerId, { role: 'provider' });
  _providerTok = (await request(app).post('/api/v1/users/login')
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

// ─── 1. (削除) escrow-service.js の settle() CAS ガード ───────────────────
// エスクロー機構ごと削除したためこの検査は不要になった（2026-09 第8回点検）。
// 二重計上防止は payout-ledger.js の createUnique（orderId 単位）が担う。
// tests/payments/no-unledgered-money.test.js 参照。

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

// ─── 3. (削除) btc-onchain のルート認証ガード ───────────────────────────
// POST /payment/btc ごと削除したためこの検査は不要になった（2026-09）。
// 「ルートが復活していないこと」の恒久ガードは
// tests/payments/no-unledgered-money.test.js が、台帳を通らない送金経路全般として持つ。

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
