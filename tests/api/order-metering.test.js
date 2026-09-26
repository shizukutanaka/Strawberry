// §13: 実消費メータリング課金テスト — 双方向ハートビート実利用秒が /stop の
// metering 記録・エスクロー按分・GET /:id/usage に反映されることを確認する。
const request = require('supertest');
const { app } = require('../../src/api/server');
const orderRouter = require('../../src/api/routes/order');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const PaymentRepository = require('../../src/db/json/PaymentRepository');

const createdGpuIds = [];
const createdOrderIds = [];
const createdPayIds = [];

async function registerAndLogin(prefix, role = 'user') {
  const u = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 24);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', role });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: login.body.token, id: login.body.user?.id || UserRepository.getByEmail(email).id };
}

async function registerAdmin() {
  const u = `adm${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 24);
  const email = `${u}@example.com`.toLowerCase();
  const reg = await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', role: 'user' });
  const userId = reg.body.id || reg.body.user?.id || UserRepository.getByEmail(email).id;
  UserRepository.update(userId, { role: 'admin' });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: login.body.token, id: userId };
}

function mkGpu(providerId) {
  const gpu = GpuRepository.create({
    name: 'Meter GPU', vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24,
    pricePerHour: 600, providerId,
  });
  createdGpuIds.push(gpu.id);
  return gpu;
}

function mkOrder(gpuId, renterId, providerId, extra = {}) {
  const order = OrderRepository.create({
    gpuId, userId: renterId, providerId,
    status: 'active', durationMinutes: 60,
    pricePerHour: 600, totalPrice: 600,
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ...extra,
  });
  createdOrderIds.push(order.id);
  return order;
}

afterAll(() => {
  for (const id of createdOrderIds) { try { OrderRepository.delete(id); } catch (_) {} }
  for (const id of createdGpuIds) { try { GpuRepository.delete(id); } catch (_) {} }
  for (const id of createdPayIds) { try { PaymentRepository.delete(id); } catch (_) {} }
  orderRouter._usageSessions.clear();
});

describe('order usage metering (§13)', () => {
  it('records metering from heartbeat session on /stop and exposes it via GET /usage', async () => {
    const admin = await registerAdmin();
    const provider = await registerAndLogin('mtr', 'provider');
    const renter = await registerAndLogin('mtr');
    const gpu = mkGpu(provider.id);
    const order = mkOrder(gpu.id, renter.id, provider.id);

    // 20分間の双方向アクティブを模擬
    const session = new orderRouter._OrderUsageSession(order.id, provider.id, renter.id);
    session.onHeartbeat(provider.id, 'lender');
    session.onHeartbeat(renter.id, 'renter');
    session.accumulatedSeconds = 1200;
    orderRouter._usageSessions.set(order.id, session);

    const res = await request(app).post(`/api/v1/orders/${order.id}/stop`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    const metering = res.body.metering;
    expect(metering).toBeTruthy();
    expect(metering.usageSeconds).toBeGreaterThanOrEqual(1200);
    expect(metering.source).toBe('heartbeat');
    // 20min = 4 units × (600/12) = 200 sats, reserved 600 → credit 400
    expect(metering.billableSats).toBe(200);
    expect(metering.reservedSats).toBe(600);
    expect(metering.creditSats).toBe(400);

    const saved = OrderRepository.getById(order.id);
    expect(saved.metering.billableSats).toBe(200);

    const usage = await request(app).get(`/api/v1/orders/${order.id}/usage`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(usage.statusCode).toBe(200);
    expect(usage.body.usageSeconds).toBe(200 * 300 / 300 === 200 ? metering.usageSeconds : metering.usageSeconds);
    expect(usage.body.billableSats).toBe(200);
    expect(usage.body.live).toBe(false);
  });

  it('GET /usage returns live heartbeat seconds for an active order', async () => {
    const provider = await registerAndLogin('mtr', 'provider');
    const renter = await registerAndLogin('mtr');
    const gpu = mkGpu(provider.id);
    const order = mkOrder(gpu.id, renter.id, provider.id);

    const session = new orderRouter._OrderUsageSession(order.id, provider.id, renter.id);
    session.accumulatedSeconds = 600;
    orderRouter._usageSessions.set(order.id, session);

    const res = await request(app).get(`/api/v1/orders/${order.id}/usage`)
      .set('Authorization', `Bearer ${provider.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.live).toBe(true);
    expect(res.body.usageSeconds).toBe(600);
    expect(res.body.billableSats).toBe(100); // 2 units × 50
  });

  it('GET /usage is rejected for non-party users', async () => {
    const provider = await registerAndLogin('mtr', 'provider');
    const renter = await registerAndLogin('mtr');
    const outsider = await registerAndLogin('mtr');
    const gpu = mkGpu(provider.id);
    const order = mkOrder(gpu.id, renter.id, provider.id);
    const res = await request(app).get(`/api/v1/orders/${order.id}/usage`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect([403, 404]).toContain(res.statusCode);
  });

  it('/stop without any session keeps metering null (wall-clock fallback for escrow)', async () => {
    const admin = await registerAdmin();
    const provider = await registerAndLogin('mtr', 'provider');
    const renter = await registerAndLogin('mtr');
    const gpu = mkGpu(provider.id);
    const order = mkOrder(gpu.id, renter.id, provider.id);

    const res = await request(app).post(`/api/v1/orders/${order.id}/stop`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.metering).toBeNull();
  });
});
