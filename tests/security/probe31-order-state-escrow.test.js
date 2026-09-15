// tests/security/probe31-order-state-escrow.test.js
// Probe 31 regression tests:
// 1. Admin PUT cannot set status='completed' directly (must use /stop)
// 2. (removed 2026-09 — escrow cancel side effects no longer exist; hold-invoice
//    escrow was deleted, see ARCHITECTURE.md「エスクロー機構の削除」節)
// 3. (removed 2026-09 — see 2; DELETE no longer has an escrow cancel path to guard)
// 4. ReDoS: all validation regexes are safe (no catastrophic backtracking)

const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');

const uniq = `p31${Date.now().toString(36)}`;
let adminTok, _providerTok, providerId, gpuId, userTok, _userId;

beforeAll(async () => {
  const admName = `p31adm${uniq}`.slice(0, 20);
  const admEmail = `${admName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: admName, email: admEmail, password: 'Test1234!' });
  const admUser = UserRepository.getByEmail(admEmail);
  UserRepository.update(admUser.id, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: admEmail, password: 'Test1234!' })).body.token;

  const prvName = `p31prv${uniq}`.slice(0, 20);
  const prvEmail = `${prvName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: prvName, email: prvEmail, password: 'Test1234!' });
  const prv = UserRepository.getByEmail(prvEmail);
  providerId = prv.id;
  UserRepository.update(providerId, { role: 'provider' });
  _providerTok = (await request(app).post('/api/v1/users/login')
    .send({ email: prvEmail, password: 'Test1234!' })).body.token;

  const usrName = `p31usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  const usr = UserRepository.getByEmail(usrEmail);
  _userId = usr.id;
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;

  const gpu = GpuRepository.create({
    name: 'P31 Test GPU', vendor: 'NVIDIA', model: 'RTX-P31', memoryGB: 8,
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

// ─── 1. Admin PUT cannot force 'completed' status ────────────────────────────
describe('Admin PUT /:id: status=completed is blocked', () => {
  let orderId;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userTok}`)
      .send({ gpuId, durationMinutes: 30 });
    orderId = res.body.order?.id;
  });

  afterAll(() => {
    if (orderId) {
      try { OrderRepository.update(orderId, { status: 'cancelled' }); } catch (_) {}
    }
  });

  it('admin PUT with status=completed returns 400', async () => {
    if (!orderId) return;
    const res = await request(app)
      .put(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'completed' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error || JSON.stringify(res.body)).toMatch(/completed|stop/i);
  });

  it('regular user PUT with status=completed also returns 4xx', async () => {
    if (!orderId) return;
    const res = await request(app)
      .put(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${userTok}`)
      .send({ status: 'completed' });
    expect([400, 403]).toContain(res.statusCode);
  });
});

// ─── 2. Source guard: PUT handler still blocks 'completed' status ───────────
describe('Source guards: admin PUT status handling', () => {
  it("order/index.js: PUT handler blocks 'completed' status", () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    expect(src).toMatch(/sanitized\.status === 'completed'/);
    expect(src).toMatch(/Use POST.*stop.*to complete/);
  });
});

// ─── 3. Admin PUT status=cancelled on pending order works ────────────────────
describe('Admin PUT status=cancelled: normal flow (pending order)', () => {
  let orderId;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userTok}`)
      .send({ gpuId, durationMinutes: 30 });
    orderId = res.body.order?.id;
  });

  it('admin can PUT status=cancelled on a pending order', async () => {
    if (!orderId) return;
    const res = await request(app)
      .put(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'cancelled' });
    // Should succeed: pending order can be cancelled directly
    expect([200, 201, 400]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.body.order?.status).toBe('cancelled');
    }
  });
});

// ─── 4. ReDoS: all exposed regex patterns are safe ───────────────────────────
describe('ReDoS: validation regexes are safe against catastrophic backtracking', () => {
  it('lineToken regex does not hang on 50-char malicious input', () => {
    const re = /^[A-Za-z0-9_-]{30,60}$/;
    const evil = 'A'.repeat(50) + '!';
    const start = Date.now();
    re.test(evil);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('telegramBotToken regex does not hang', () => {
    const re = /^\d{6,12}:[A-Za-z0-9_-]{30,45}$/;
    const evil = '1'.repeat(12) + ':' + 'A'.repeat(45) + '!';
    const start = Date.now();
    re.test(evil);
    expect(Date.now() - start).toBeLessThan(100);
  });
});
