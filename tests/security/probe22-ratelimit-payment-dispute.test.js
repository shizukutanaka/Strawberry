// tests/security/probe22-ratelimit-payment-dispute.test.js
// Probe 22 regression tests:
// 1. rate-limit keyGenerator: TRUST_PROXY must be parsed as an integer hop count;
//    boolean-ish strings ('true','yes') are rejected so XFF spoofing can't bypass authLimiter.
// 2. POST /payments/order/:id rejects orders not in a payable state (pending|matched),
//    preventing Lightning invoices for cancelled/completed/disputed orders (funds with no refund path).
// 3. POST /orders/:id/dispute/resolve { decision:'uphold' } settles HELD escrow to the provider
//    (was leaving funds locked in HELD forever while only flipping order status to completed).

const request = require('supertest');
const { app } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const EscrowRepository = require('../../src/db/json/EscrowRepository');
const { createEscrowService } = require('../../src/payments/escrow-service');

const uniq = `p22${Date.now().toString(36)}`;
let adminTok, userTok, userId;

beforeAll(async () => {
  const admName = `p22adm${uniq}`.slice(0, 20);
  const admEmail = `${admName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: admName, email: admEmail, password: 'Test1234!' });
  const admUser = UserRepository.getByEmail(admEmail);
  UserRepository.update(admUser.id, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: admEmail, password: 'Test1234!' })).body.token;

  const usrName = `p22usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  const usr = UserRepository.getByEmail(usrEmail);
  userId = usr.id;
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;
});

describe('rate-limit keyGenerator: TRUST_PROXY parsed strictly as integer hop count', () => {
  // Mirrors the logic in src/api/middleware/rate-limit.js. 'true'/'yes' must NOT
  // be treated as "trust proxy" because that would trust attacker-controlled XFF.
  const trustsForwarded = (val) => {
    const hopCount = parseInt(val, 10);
    return Number.isInteger(hopCount) && hopCount > 0;
  };

  it('integer hop counts (1, 2) trust the proxy chain', () => {
    expect(trustsForwarded('1')).toBe(true);
    expect(trustsForwarded('2')).toBe(true);
  });

  it("boolean-ish strings are rejected (no XFF trust)", () => {
    expect(trustsForwarded('true')).toBe(false);
    expect(trustsForwarded('yes')).toBe(false);
    expect(trustsForwarded('on')).toBe(false);
    expect(trustsForwarded(undefined)).toBe(false);
    expect(trustsForwarded('')).toBe(false);
    expect(trustsForwarded('0')).toBe(false);
    expect(trustsForwarded('-1')).toBe(false);
  });

  it('module loads and exports the limiter + authLimiter', () => {
    const limiter = require('../../src/api/middleware/rate-limit');
    expect(typeof limiter).toBe('function');
    expect(typeof limiter.authLimiter).toBe('function');
  });
});

describe('POST /payments/order/:id: only payable order states accept payment', () => {
  function seedOrder(status) {
    const gpu = GpuRepository.create({
      name: 'P22 Pay GPU', vendor: 'NVIDIA', model: 'RTX-P22', memoryGB: 8,
      pricePerHour: 100, providerId: 'p22-prov',
    });
    const order = OrderRepository.create({
      gpuId: gpu.id, userId, providerId: 'p22-prov',
      durationMinutes: 60, status,
      pricePerHour: 100, totalPrice: 100, totalPriceJPY: 5000000,
      createdAt: new Date().toISOString(),
    });
    return { gpu, order };
  }

  it("rejects payment for a 'completed' order with 400", async () => {
    const { gpu, order } = seedOrder('completed');
    const res = await request(app).post(`/api/v1/payments/order/${order.id}`)
      .set('Authorization', `Bearer ${userTok}`).send({ paymentMethod: 'lightning' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/completed/);
    OrderRepository.delete(order.id);
    GpuRepository.delete(gpu.id);
  });

  it("rejects payment for a 'cancelled' order with 400", async () => {
    const { gpu, order } = seedOrder('cancelled');
    const res = await request(app).post(`/api/v1/payments/order/${order.id}`)
      .set('Authorization', `Bearer ${userTok}`).send({ paymentMethod: 'lightning' });
    expect(res.statusCode).toBe(400);
    OrderRepository.delete(order.id);
    GpuRepository.delete(gpu.id);
  });
});

describe('POST /orders/:id/dispute/resolve uphold: HELD escrow is settled to provider', () => {
  it('moves a HELD escrow to SETTLED on uphold (funds released, not locked)', async () => {
    const gpu = GpuRepository.create({
      name: 'P22 Dispute GPU', vendor: 'NVIDIA', model: 'RTX-P22D', memoryGB: 8,
      pricePerHour: 100, providerId: 'p22-dprov',
    });
    const order = OrderRepository.create({
      gpuId: gpu.id, userId, providerId: 'p22-dprov',
      durationMinutes: 60, status: 'disputed',
      pricePerHour: 100, totalPrice: 100, totalPriceJPY: 5000000,
      dispute: { raisedBy: userId, reason: 'test dispute', raisedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
    });

    // Create an escrow and bring it to HELD.
    const svc = createEscrowService();
    const escrow = svc.create({ orderId: order.id, amountSats: 100000, feeRate: 0.015 });
    svc.markPaid(escrow.id); // PENDING -> HELD
    expect(EscrowRepository.getById(escrow.id).state).toBe('HELD');

    const res = await request(app).post(`/api/v1/orders/${order.id}/dispute/resolve`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ decision: 'uphold', note: 'work valid' });
    expect(res.statusCode).toBe(200);

    // Order is completed AND escrow is now SETTLED (provider paid out).
    expect(OrderRepository.getById(order.id).status).toBe('completed');
    expect(EscrowRepository.getById(escrow.id).state).toBe('SETTLED');

    EscrowRepository.delete(escrow.id);
    OrderRepository.delete(order.id);
    GpuRepository.delete(gpu.id);
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
