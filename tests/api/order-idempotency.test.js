// POST /orders の冪等性キー（Stripe 流 Idempotency-Key / body.idempotencyKey）。
const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');

const gpuIds = [];
const orderIds = [];

async function registerAndLogin(prefix, role = 'provider') {
  const u = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 24);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', role });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return login.body.token;
}

async function createGpu(token) {
  const res = await request(app).post('/api/v1/gpus')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: `Idem GPU ${Math.random().toString(36).slice(2, 8)}`, vendor: 'NVIDIA', model: 'RTX 3080', apiType: 'CUDA',
      driverVersion: '550.54', os: 'Linux', arch: 'x86_64',
      memoryGB: 10, clockMHz: 1710, powerWatt: 320, pricePerHour: 500,
    });
  expect(res.statusCode).toBe(201);
  const gpu = res.body.gpu || res.body;
  gpuIds.push(gpu.id);
  return gpu;
}

afterAll(() => {
  for (const id of orderIds) { try { OrderRepository.delete(id); } catch (_) {} }
  for (const id of gpuIds) { try { GpuRepository.delete(id); } catch (_) {} }
});

describe('order creation idempotency', () => {
  it('replayed Idempotency-Key returns the same order without creating a duplicate', async () => {
    const p = await registerAndLogin('idp');
    const gpu = await createGpu(p);
    const r = await registerAndLogin('idr', 'user');
    const key = `idem-${Date.now()}`;

    const res1 = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${r}`)
      .set('Idempotency-Key', key)
      .send({ gpuId: gpu.id, durationMinutes: 60, paymentMethod: 'onchain' });
    expect(res1.statusCode).toBe(201);
    const order1 = res1.body.order || res1.body;
    orderIds.push(order1.id);

    const res2 = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${r}`)
      .set('Idempotency-Key', key)
      .send({ gpuId: gpu.id, durationMinutes: 60, paymentMethod: 'onchain' });
    expect(res2.statusCode).toBe(200);
    expect(res2.body.idempotentReplay).toBe(true);
    expect(res2.body.order.id).toBe(order1.id);
  });

  it('same key from a different user creates a separate order', async () => {
    const p = await registerAndLogin('idp');
    const gpu1 = await createGpu(p);
    const gpu2 = await createGpu(p); // 別 GPU — 同一 GPU 連続予約は二重予約チェックで 409 になる
    const r1 = await registerAndLogin('idr', 'user');
    const r2 = await registerAndLogin('idr', 'user');
    const key = `idem-shared-${Date.now()}`;

    const a = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${r1}`)
      .send({ gpuId: gpu1.id, durationMinutes: 60, paymentMethod: 'onchain', idempotencyKey: key });
    const b = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${r2}`)
      .send({ gpuId: gpu2.id, durationMinutes: 60, paymentMethod: 'onchain', idempotencyKey: key });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    orderIds.push((a.body.order || a.body).id, (b.body.order || b.body).id);
    expect((a.body.order || a.body).id).not.toBe((b.body.order || b.body).id);
  });

  it('no key → every request creates a new order', async () => {
    const p = await registerAndLogin('idp');
    const gpu1 = await createGpu(p);
    const gpu2 = await createGpu(p);
    const r = await registerAndLogin('idr', 'user');
    const a = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${r}`)
      .send({ gpuId: gpu1.id, durationMinutes: 60, paymentMethod: 'onchain' });
    const b = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${r}`)
      .send({ gpuId: gpu2.id, durationMinutes: 60, paymentMethod: 'onchain' });
    orderIds.push((a.body.order || a.body).id, (b.body.order || b.body).id);
    expect((a.body.order || a.body).id).not.toBe((b.body.order || b.body).id);
  });
});
