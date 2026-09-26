// §4(3): idleDiscount GPU での注文価格逓減・一覧の effectivePricePerHour。
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

async function createGpu(token, extra = {}) {
  const res = await request(app).post('/api/v1/gpus')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Idle GPU', vendor: 'NVIDIA', model: 'RTX 3080', apiType: 'CUDA',
      driverVersion: '550.54', os: 'Linux', arch: 'x86_64',
      memoryGB: 10, clockMHz: 1710, powerWatt: 320, pricePerHour: 1000,
      ...extra,
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

describe('idle discount pricing (§4)', () => {
  it('order uses the idle-discounted price and records base/discount', async () => {
    const p = await registerAndLogin('idl');
    const gpu = await createGpu(p, {
      idleDiscount: { enabled: true, pctPerHour: 10, maxPct: 50, thresholdHours: 0 },
    });
    // GPU は一度も使われていない → 空転起点は登録時刻（このテストでは直近）…だが
    // thresholdHours:0 かつ作成直後なので割引ほぼ0。確実に割引を得るため
    // createdAt を過去にずらす（リポジトリ直書き = テスト内のセットアップ）。
    GpuRepository.update(gpu.id, { createdAt: new Date(Date.now() - 10 * 3.6e6).toISOString() });

    const renter = await registerAndLogin('idlr', 'user');
    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter}`)
      .send({ gpuId: gpu.id, durationMinutes: 60, paymentMethod: 'onchain' });
    expect(res.statusCode).toBe(201);
    const order = res.body.order || res.body;
    orderIds.push(order.id);
    expect(order.idleDiscount).toBeTruthy();
    expect(order.idleDiscount.discountPct).toBeGreaterThan(0);
    expect(order.pricePerHour).toBeLessThan(1000);
    expect(order.idleDiscount.basePricePerHour).toBe(1000);
  });

  it('no idleDiscount → order keeps list price', async () => {
    const p = await registerAndLogin('idl');
    const gpu = await createGpu(p);
    const renter = await registerAndLogin('idlr', 'user');
    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter}`)
      .send({ gpuId: gpu.id, durationMinutes: 60, paymentMethod: 'onchain' });
    expect(res.statusCode).toBe(201);
    const order = res.body.order || res.body;
    orderIds.push(order.id);
    expect(order.pricePerHour).toBe(1000);
    expect(order.idleDiscount).toBeUndefined();
  });

  it('GET /gpus exposes effectivePricePerHour for discounted GPUs', async () => {
    const p = await registerAndLogin('idl');
    const gpu = await createGpu(p, {
      idleDiscount: { enabled: true, pctPerHour: 10, thresholdHours: 0 },
    });
    GpuRepository.update(gpu.id, { createdAt: new Date(Date.now() - 10 * 3.6e6).toISOString() });
    const res = await request(app).get('/api/v1/gpus?limit=200');
    expect(res.statusCode).toBe(200);
    const row = res.body.gpus.find((g) => g.id === gpu.id);
    expect(row.effectivePricePerHour).toBeLessThan(1000);
    expect(row.idleDiscountPct).toBeGreaterThan(0);
  });
});
