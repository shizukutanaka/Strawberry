// tests/security/probe26-escrow-match-lock.test.js
// Probe 26 regression tests:
// 1. /escrow/:id/verify and /escrow/:id/resolve now share the same lock key (escrow:${id})
//    — no concurrent double-settlement side effects.
// 2. escrowSvc.settle() uses updateIf to prevent overwriting an already-written settlement.
// 3. POST /orders/:id/match: double-booking check under gpu:${id}:book lock prevents
//    a P2P-matched GPU from being assigned to two orders simultaneously.

const request = require('supertest');
const { app } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const EscrowRepository = require('../../src/db/json/EscrowRepository');

const uniq = `p26${Date.now().toString(36)}`;
let adminTok, userTok, userId, adminId;

beforeAll(async () => {
  const admName = `p26adm${uniq}`.slice(0, 20);
  const admEmail = `${admName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: admName, email: admEmail, password: 'Test1234!' });
  const admUser = UserRepository.getByEmail(admEmail);
  adminId = admUser.id;
  UserRepository.update(admUser.id, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: admEmail, password: 'Test1234!' })).body.token;

  const usrName = `p26usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  const usr = UserRepository.getByEmail(usrEmail);
  userId = usr.id;
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;
});

// ─── 1. marketplace.js: /verify and /resolve share lock key escrow:${id} ─────
describe('marketplace.js: /verify and /resolve share lock key', () => {
  it('marketplace.js source: /resolve uses escrow:${id} not escrow:${id}:resolve', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/marketplace.js'), 'utf-8'
    );
    // Must NOT have the old ':resolve' suffix key
    expect(src).not.toMatch(/withLock\(`escrow:\$\{[^}]+\}:resolve`/);
    // Both /verify and /resolve must use the same escrow:${id} key
    const lockMatches = [...src.matchAll(/withLock\(`escrow:\$\{req\.params\.id\}`/g)];
    expect(lockMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('/resolve returns 400 for invalid decision (guard still works after lock-key fix)', async () => {
    const res = await request(app)
      .post('/api/v1/marketplace/escrow/some-id/resolve')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ decision: 'invalid' });
    expect(res.statusCode).toBe(400);
  });

  it('/resolve returns 404 for non-existent escrow with providerId', async () => {
    const res = await request(app)
      .post('/api/v1/marketplace/escrow/does-not-exist/resolve')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ decision: 'settle', providerId: 'some-prov' });
    expect(res.statusCode).toBe(404);
  });
});

// ─── 2. escrowSvc.settle() uses updateIf (defense-in-depth) ──────────────────
describe('escrowSvc.settle(): updateIf prevents double-settlement overwrite', () => {
  it('escrow-service.js source: settle() uses updateIf or falls back safely', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/payments/escrow-service.js'), 'utf-8'
    );
    // Must NOT use unconditional repo.update() for settlement
    // (the old: const saved = repo.update(escrow.id, { settlement, ... }))
    expect(src).not.toMatch(/const saved = repo\.update\(escrow\.id/);
    // Must use updateIf or equivalent guard
    expect(src).toMatch(/CONCURRENT_SETTLE|updateIf.*settlement|settlement.*updateIf/s);
  });

  it('escrowSvc.settle() on a valid HELD escrow succeeds and returns settlement', () => {
    const { createEscrowService } = require('../../src/payments/escrow-service');
    const svc = createEscrowService();

    // Create an escrow in HELD state via open + pay
    const gpu = GpuRepository.create({
      name: 'P26 Settle GPU', vendor: 'NVIDIA', model: 'RTX-P26S', memoryGB: 8,
      pricePerHour: 100, providerId: 'p26s-prov',
    });
    const order = OrderRepository.create({
      gpuId: gpu.id, userId, providerId: 'p26s-prov',
      durationMinutes: 60, status: 'matched',
      pricePerHour: 100, totalPrice: 100, totalPriceJPY: 5000,
      createdAt: new Date().toISOString(),
    });
    const created = svc.create({ orderId: order.id, amountSats: 10000, feeRate: 0.05 });
    const afterPay = svc.markPaid(created.id); // returns { escrow, actions, event }
    expect(afterPay.escrow.state).toBe('HELD');

    const { settlement } = svc.settle(created.id, { deliveredRatio: 1, slaUptimePct: 100 });
    expect(settlement).toBeDefined();
    expect(typeof settlement.providerPayoutSats).toBe('number');

    GpuRepository.delete(gpu.id);
    OrderRepository.delete(order.id);
    EscrowRepository.delete(created.id);
  });
});

// ─── 3. POST /orders/:id/match: double-booking guard under gpu lock ───────────
describe('POST /orders/:id/match: GPU double-booking check via lock', () => {
  it('order/index.js source: /match uses withLock(gpu:${gpuId}:book) with booking check', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    expect(src).toMatch(/withLock\(`gpu:\$\{matchedGpuId\}:book`/);
    expect(src).toMatch(/gpu_double_booked/);
  });

  it('/match returns 404 when order does not exist', async () => {
    const res = await request(app)
      .post('/api/v1/orders/00000000-0000-4000-8000-000000000099/match')
      .set('Authorization', `Bearer ${userTok}`);
    expect(res.statusCode).toBe(404);
  });

  it('/match returns 400 when order is not in pending state', async () => {
    const gpu = GpuRepository.create({
      name: 'P26 Match GPU', vendor: 'NVIDIA', model: 'RTX-P26M', memoryGB: 8,
      pricePerHour: 1, providerId: 'p26m-prov',
    });
    const order = OrderRepository.create({
      gpuId: gpu.id, userId, providerId: 'p26m-prov',
      durationMinutes: 60, status: 'active',  // not pending
      pricePerHour: 1, totalPrice: 1, totalPriceJPY: 100,
      createdAt: new Date().toISOString(),
    });

    const res = await request(app)
      .post(`/api/v1/orders/${order.id}/match`)
      .set('Authorization', `Bearer ${userTok}`);
    expect(res.statusCode).toBe(400);

    OrderRepository.delete(order.id);
    GpuRepository.delete(gpu.id);
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
