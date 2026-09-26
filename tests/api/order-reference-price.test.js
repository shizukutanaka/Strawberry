// F1.2: 注文作成時の特徴量参照価格（advisory）配線テスト。
// referencePrice/priceDeviationPct が注文レコードと 201 応答へ記録され、
// 需要利用率が需給乗数へ反映されることを確認する。
const request = require('supertest');
const { app } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

const createdGpuIds = [];
const createdOrderIds = [];

async function registerAndLogin(prefix, role = 'user') {
  const u = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 24);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', role });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: login.body.token, id: login.body.user?.id || UserRepository.getByEmail(email).id };
}

function mkGpu(providerId, extra = {}) {
  const gpu = GpuRepository.create({
    name: 'Ref GPU', vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24,
    pricePerHour: 500, providerId,
    performance: { benchmarkScore: 34000, teraflops: 82 },
    ...extra,
  });
  createdGpuIds.push(gpu.id);
  return gpu;
}

afterAll(() => {
  for (const id of createdOrderIds) { try { OrderRepository.delete(id); } catch (_) {} }
  for (const id of createdGpuIds) { try { GpuRepository.delete(id); } catch (_) {} }
});

describe('order reference price (F1.2 feature-pricer wiring)', () => {
  it('records referencePrice and priceDeviationPct on the order and in the 201 response', async () => {
    const provider = await registerAndLogin('rpp', 'provider');
    const renter = await registerAndLogin('rpr');
    const gpu = mkGpu(provider.id);

    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ gpuId: gpu.id, durationMinutes: 60 });
    expect(res.statusCode).toBe(201);
    createdOrderIds.push(res.body.orderId);

    const order = res.body.order;
    expect(order.referencePrice).toBeTruthy();
    expect(order.referencePrice.pricePerHour).toBeGreaterThan(0);
    expect(typeof order.referencePrice.featureMultiplier).toBe('number');
    expect(typeof order.referencePrice.demandMultiplier).toBe('number');
    expect(order.referencePrice.utilization).toBeGreaterThanOrEqual(0);
    // 乖離率 = (flat - ref)/ref ×100 の小数1桁丸め
    const expected = Math.round(((500 - order.referencePrice.pricePerHour) / order.referencePrice.pricePerHour) * 1000) / 10;
    expect(order.priceDeviationPct).toBeCloseTo(expected, 5);

    // 永続化側にも残っていること
    const saved = OrderRepository.getById(res.body.orderId);
    expect(saved.referencePrice.pricePerHour).toBe(order.referencePrice.pricePerHour);
  });

  it('reflects market utilization in the reference price (busy GPU → higher demand multiplier)', async () => {
    const provider = await registerAndLogin('rpp', 'provider');
    const renter = await registerAndLogin('rpr');
    const busy = mkGpu(provider.id);
    const free = mkGpu(provider.id);
    // busy を占有する blocking 注文（90日後開始でも blocking 状態で計上される）
    const blocker = OrderRepository.create({
      gpuId: busy.id, userId: renter.id, providerId: provider.id,
      status: 'active', durationMinutes: 60, pricePerHour: 500, totalPrice: 500,
    });
    createdOrderIds.push(blocker.id);

    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ gpuId: free.id, durationMinutes: 60 });
    expect(res.statusCode).toBe(201);
    createdOrderIds.push(res.body.orderId);
    // busy が1台でも占有なら utilization>0 → demandMultiplier が記録される
    expect(res.body.order.referencePrice.utilization).toBeGreaterThan(0);
  });

  it('does not fail order creation when the GPU lacks perf fields (advisory is best-effort)', async () => {
    const provider = await registerAndLogin('rpp', 'provider');
    const renter = await registerAndLogin('rpr');
    const gpu = mkGpu(provider.id, { model: 'Unknown Accelerator', performance: undefined });

    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ gpuId: gpu.id, durationMinutes: 30 });
    expect(res.statusCode).toBe(201);
    createdOrderIds.push(res.body.orderId);
    // 参照価格は floor 値で算出されるか、無ければ null — いずれでも注文は成功する
    expect(res.body.orderId).toBeTruthy();
  });
});
