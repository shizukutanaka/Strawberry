// tests/api/marketplace-escrow.test.js
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../src/api/server');
const { config } = require('../../src/utils/config');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');

const adminTok = jwt.sign({ id: 'admin1', role: 'admin' }, config.security.jwtSecret);
const userTok = jwt.sign({ id: 'user1', role: 'user' }, config.security.jwtSecret);
const asAdmin = (r) => r.set('Authorization', `Bearer ${adminTok}`);

// Seed a minimal order with a locked price to use in escrow tests
function seedOrder(overrides = {}) {
  const gpu = GpuRepository.create({
    name: 'Escrow Test GPU', vendor: 'NVIDIA', model: 'RTX-ESC', memoryGB: 8,
    pricePerHour: 100, providerId: 'prov-escrow-test',
  });
  return OrderRepository.create({
    gpuId: gpu.id, userId: 'user-escrow-test', providerId: 'prov-escrow-test',
    durationMinutes: 60, status: 'matched',
    pricePerHour: 100, totalPrice: 100, totalPriceJPY: 5000000,
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

describe('marketplace escrow lifecycle API', () => {
  it('escrow ops require admin role (403 for plain user)', async () => {
    const order = seedOrder();
    const res = await request(app)
      .post('/api/v1/marketplace/escrow/open')
      .set('Authorization', `Bearer ${userTok}`)
      .send({ orderId: order.id });
    expect(res.statusCode).toBe(403);
    OrderRepository.update(order.id, { status: 'cancelled' });
  });

  it('drives the full happy path: open -> pay -> verify -> SETTLED', async () => {
    const order = seedOrder();
    const opened = await asAdmin(request(app).post('/api/v1/marketplace/escrow/open'))
      .send({ orderId: order.id, feeRate: 0 });
    expect(opened.statusCode).toBe(201);
    expect(opened.body.escrow.state).toBe('PENDING');
    // amountSats must match the order's locked totalPrice, not a live re-quote
    expect(opened.body.amountSats).toBe(order.totalPrice);
    const id = opened.body.escrow.id;

    const paid = await asAdmin(request(app).post(`/api/v1/marketplace/escrow/${id}/pay`)).send({});
    expect(paid.statusCode).toBe(200);
    expect(paid.body.escrow.state).toBe('HELD');

    const verified = await asAdmin(request(app).post(`/api/v1/marketplace/escrow/${id}/verify`))
      .send({ jobId: `job-${Date.now()}`, providerId: 'prov-escrow-test', primaryOutput: [1, 2, 3], utilSamples: [80, 90, 85], auditRate: 0 });
    expect(verified.statusCode).toBe(200);
    expect(verified.body.event).toBe('DELIVER_OK');
    expect(verified.body.escrow.state).toBe('SETTLED');
    expect(verified.body.actions).toContain('reveal_preimage');

    const got = await asAdmin(request(app).get(`/api/v1/marketplace/escrow/${id}`));
    expect(got.statusCode).toBe(200);
    expect(got.body.state).toBe('SETTLED');
    OrderRepository.update(order.id, { status: 'completed' });
  });

  it('validates inputs: missing orderId → 400', async () => {
    const noOrder = await asAdmin(request(app).post('/api/v1/marketplace/escrow/open')).send({});
    expect(noOrder.statusCode).toBe(400);
  });

  it('validates inputs: unknown orderId → 404', async () => {
    const res = await asAdmin(request(app).post('/api/v1/marketplace/escrow/open'))
      .send({ orderId: `does-not-exist-${Date.now()}` });
    expect(res.statusCode).toBe(404);
  });

  it('validate inputs: order with no totalPrice → 422', async () => {
    const order = seedOrder({ totalPrice: null });
    const res = await asAdmin(request(app).post('/api/v1/marketplace/escrow/open'))
      .send({ orderId: order.id });
    expect(res.statusCode).toBe(422);
    OrderRepository.update(order.id, { status: 'cancelled' });
  });

  it('validates inputs: missing jobId on verify → 400', async () => {
    const order = seedOrder();
    const opened = await asAdmin(request(app).post('/api/v1/marketplace/escrow/open'))
      .send({ orderId: order.id, feeRate: 0 });
    const id = opened.body.escrow.id;

    const noJob = await asAdmin(request(app).post(`/api/v1/marketplace/escrow/${id}/verify`)).send({ primaryOutput: [1] });
    expect(noJob.statusCode).toBe(400);

    const badResolve = await asAdmin(request(app).post(`/api/v1/marketplace/escrow/${id}/resolve`)).send({ decision: 'nope' });
    expect(badResolve.statusCode).toBe(400);
    OrderRepository.update(order.id, { status: 'cancelled' });
  });

  it('returns 404 for unknown escrow', async () => {
    const res = await asAdmin(request(app).get('/api/v1/marketplace/escrow/does-not-exist'));
    expect(res.statusCode).toBe(404);
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
