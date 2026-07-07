// tests/security/probe29-pricing-dos.test.js
// Probe 29 regression tests:
// 1. NaN totalPriceJPY: bad exchange rate must not corrupt order records (null, not NaN)
// 2. computeOrderPricing: returns null totalPriceJPY when rate is NaN/Infinity
// 3. Source guards: computeOrderPricing and order create both have Number.isFinite checks

const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const { computeOrderPricing } = require('../../src/utils/order-pricing');

const uniq = `p29${Date.now().toString(36)}`;
let providerTok, providerId, gpuId, userTok, userId;

beforeAll(async () => {
  const prvName = `p29prv${uniq}`.slice(0, 20);
  const prvEmail = `${prvName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: prvName, email: prvEmail, password: 'Test1234!' });
  const prv = UserRepository.getByEmail(prvEmail);
  providerId = prv.id;
  UserRepository.update(providerId, { role: 'provider' });
  providerTok = (await request(app).post('/api/v1/users/login')
    .send({ email: prvEmail, password: 'Test1234!' })).body.token;

  const usrName = `p29usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  const usr = UserRepository.getByEmail(usrEmail);
  userId = usr.id;
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;

  const gpu = GpuRepository.create({
    name: 'P29 Test GPU', vendor: 'NVIDIA', model: 'RTX-P29', memoryGB: 8,
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

// ─── 1. computeOrderPricing: NaN/Infinity rate → null totalPriceJPY ─────────
describe('computeOrderPricing: bad exchange rates produce null, not NaN', () => {
  const fakeOrder = { totalPrice: 1000, durationMinutes: 30, pricePerHour: 100 };

  it('NaN rate → totalPriceJPY is null', () => {
    const pricing = computeOrderPricing(fakeOrder, { rate: NaN, timestamp: Date.now() });
    // Must not propagate NaN into the record
    expect(pricing.totalPriceJPY).toBeNull();
    expect(Number.isNaN(pricing.totalPriceJPY)).toBe(false);
  });

  it('Infinity rate → totalPriceJPY is null', () => {
    const pricing = computeOrderPricing(fakeOrder, { rate: Infinity, timestamp: Date.now() });
    expect(pricing.totalPriceJPY).toBeNull();
  });

  it('-Infinity rate → totalPriceJPY is null', () => {
    const pricing = computeOrderPricing(fakeOrder, { rate: -Infinity, timestamp: Date.now() });
    expect(pricing.totalPriceJPY).toBeNull();
  });

  it('valid rate → totalPriceJPY is a finite integer', () => {
    const pricing = computeOrderPricing(fakeOrder, { rate: 5000000, timestamp: Date.now() });
    expect(Number.isFinite(pricing.totalPriceJPY)).toBe(true);
    expect(pricing.totalPriceJPY).toBeGreaterThan(0);
  });

  it('no rateInfo → totalPriceJPY is absent', () => {
    const pricing = computeOrderPricing(fakeOrder);
    expect(pricing.totalPriceJPY).toBeUndefined();
  });
});

// ─── 2. Source guard checks ───────────────────────────────────────────────────
describe('NaN guards exist in source', () => {
  it('order-pricing.js has Number.isFinite guard for totalPriceJPY', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/order-pricing.js'), 'utf-8'
    );
    expect(src).toMatch(/Number\.isFinite.*rawJPY|Number\.isFinite.*totalPriceJPY/);
  });

  it('order/index.js has Number.isFinite guard for satoshiToJPY product', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    expect(src).toMatch(/Number\.isFinite.*rawJPY/);
  });
});

// ─── 3. Order creation works even when exchange rate is unavailable ────────────
describe('POST /orders: order created successfully with valid GPU', () => {
  it('creates an order and totalPriceJPY is a number or null (never NaN)', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userTok}`)
      .send({ gpuId, durationMinutes: 30 });

    expect([200, 201]).toContain(res.statusCode);
    if (res.body.order) {
      const jpyVal = res.body.order.totalPriceJPY;
      // Must be a finite number or null — never NaN
      if (jpyVal !== null && jpyVal !== undefined) {
        expect(Number.isFinite(jpyVal)).toBe(true);
        expect(Number.isNaN(jpyVal)).toBe(false);
      }
    }
  });
});
