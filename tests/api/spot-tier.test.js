// §9 spot/中断可能ティアの API 統合テスト:
// GPU 出品の spot 価格掲示、spot 注文の割引価格、preempt ライフサイクル
// （権限・ティアガード・実経過課金・レピュテーション反映・代替 GPU サジェスト）。
const request = require('supertest');
const { app } = require('../../src/api/server');
const { lightning } = require('../../src/core/services');
const invoicePoller = require('../../src/core/invoice-poller');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');
const PaymentRepository = require('../../src/db/json/PaymentRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const ReputationRepository = require('../../src/db/json/ReputationRepository');

const uniq = `spot${Date.now().toString(36)}`;

async function registerAndLogin(prefix, role) {
  const u = `${prefix}${uniq}`.slice(0, 28);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', ...(role ? { role } : {}) });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: login.body.token, id: login.body.user?.id || UserRepository.getByEmail(email)?.id };
}

const createdGpuIds = [];
const mkGpu = (providerId, extra = {}) => GpuRepository.create({
  name: `Spot GPU ${uniq}`, vendor: 'NVIDIA', model: 'RTX-SPOT', memoryGB: 24,
  pricePerHour: 120, providerId, available: true, ...extra,
});

afterAll(() => {
  for (const id of createdGpuIds) { try { GpuRepository.delete(id); } catch (_) {} }
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close();
});

describe('spot tier on GPU listings', () => {
  let provider;

  beforeAll(async () => { provider = await registerAndLogin('spotp', 'provider'); });

  it('exposes effective spot price on GPU detail when spotEnabled', async () => {
    const g = mkGpu(provider.id, { spotEnabled: true, spotPricePerHour: 80 });
    createdGpuIds.push(g.id);
    const res = await request(app).get(`/api/v1/gpus/${g.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.gpu.spot).toEqual({ enabled: true, pricePerHour: 80 });
  });

  it('omits spot info for non-spot GPUs and defaults the discount when enabled bare', async () => {
    const plain = mkGpu(provider.id);
    const bare = mkGpu(provider.id, { spotEnabled: true });
    createdGpuIds.push(plain.id, bare.id);
    // limit 既定50 — 他スイートの fixture と混ざるため十分な上限で取得する
    const list = await request(app).get('/api/v1/gpus?limit=200');
    expect(list.statusCode).toBe(200);
    const plainRow = list.body.gpus.find((g) => g.id === plain.id);
    const bareRow = list.body.gpus.find((g) => g.id === bare.id);
    expect(plainRow.spot).toBeUndefined();
    expect(bareRow.spot.enabled).toBe(true);
    // 既定 30% off: 120 → 84
    expect(bareRow.spot.pricePerHour).toBeCloseTo(84);
  });
});

describe('spot order pricing + preemption lifecycle', () => {
  let renter, provider, gpu, altGpu;

  beforeAll(async () => {
    renter = await registerAndLogin('spotr');
    provider = await registerAndLogin('spotprov', 'provider');
    gpu = mkGpu(provider.id, { spotEnabled: true, spotPricePerHour: 60 });
    // 同モデルの代替 spot GPU（preempt 応答の alternatives 検証用）
    altGpu = mkGpu(provider.id, { spotEnabled: true, spotPricePerHour: 50 });
    createdGpuIds.push(gpu.id, altGpu.id);
    if (typeof lightning.setupMockLND === 'function') lightning.setupMockLND();
  });

  it('rejects a spot order on a non-spot GPU', async () => {
    const nonSpot = mkGpu(provider.id);
    createdGpuIds.push(nonSpot.id);
    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ gpuId: nonSpot.id, durationMinutes: 60, tier: 'spot' });
    expect(res.statusCode).toBe(409);
  });

  it('creates a spot order at the discounted price and records the tier', async () => {
    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ gpuId: gpu.id, durationMinutes: 60, tier: 'spot' });
    expect(res.statusCode).toBe(201);
    const order = res.body.order;
    expect(order.tier).toBe('spot');
    expect(order.pricePerHour).toBe(60); // spot 価格 120→60
    expect(order.totalPrice).toBe(60);   // 60min × 60/h
  });

  it('lets the provider preempt the spot order; renter/others cannot', async () => {
    const order = OrderRepository.getAll().find((o) => o.gpuId === gpu.id && o.tier === 'spot');
    expect(order).toBeTruthy();

    const forbidden = await request(app).post(`/api/v1/orders/${order.id}/preempt`)
      .set('Authorization', `Bearer ${renter.token}`)
      .send({});
    expect(forbidden.statusCode).toBe(403);

    const res = await request(app).post(`/api/v1/orders/${order.id}/preempt`)
      .set('Authorization', `Bearer ${provider.token}`)
      .send({ noticeSec: 45, reason: 'maintenance' });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('preempted');
    expect(res.body.preemption.noticeSec).toBe(45);
    expect(res.body.preemption.reason).toBe('maintenance');
    // alternatives に同モデルの altGpu が含まれる
    expect(res.body.alternatives.some((a) => a.gpuId === altGpu.id)).toBe(true);

    const updated = OrderRepository.getById(order.id);
    expect(updated.status).toBe('preempted');
    expect(updated.preemption.requestedAt).toBeTruthy();
  });

  it('records the preemption in the provider reputation stats', async () => {
    const rec = ReputationRepository.getByProviderId(provider.id);
    expect(rec).toBeTruthy();
    expect(rec.stats.preemptions).toBeGreaterThanOrEqual(1);
    expect(rec.stats.interruptionRate).toBeGreaterThan(0);
  });

  it('refuses to preempt a reserved-tier order', async () => {
    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ gpuId: gpu.id, durationMinutes: 60 });
    expect(res.statusCode).toBe(201);
    const preempt = await request(app).post(`/api/v1/orders/${res.body.orderId}/preempt`)
      .set('Authorization', `Bearer ${provider.token}`)
      .send({});
    expect(preempt.statusCode).toBe(409);
    // 片付け: 後続テストのブロッキングを避けるためキャンセル
    await request(app).delete(`/api/v1/orders/${res.body.orderId}`)
      .set('Authorization', `Bearer ${renter.token}`);
  });

  it('charges only elapsed time when an active spot order is preempted', async () => {
    // 本物の order→accept→pay→start チェーンで active まで進める
    const orderRes = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ gpuId: gpu.id, durationMinutes: 60, tier: 'spot' });
    expect(orderRes.statusCode).toBe(201);
    const orderId = orderRes.body.orderId;

    await request(app).post(`/api/v1/orders/${orderId}/accept`)
      .set('Authorization', `Bearer ${provider.token}`);

    const payRes = await request(app).post(`/api/v1/payments/order/${orderId}`)
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ paymentMethod: 'lightning' });
    expect(payRes.statusCode).toBe(201);
    const tracked = lightning.invoices.get(payRes.body.invoiceId);
    tracked.status = 'paid';
    tracked.amountPaid = tracked.amount;
    tracked.settledAt = Date.now();
    await invoicePoller.pollOnce();

    const startRes = await request(app).post(`/api/v1/orders/${orderId}/start`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(startRes.statusCode).toBe(200);

    const preempt = await request(app).post(`/api/v1/orders/${orderId}/preempt`)
      .set('Authorization', `Bearer ${provider.token}`)
      .send({});
    expect(preempt.statusCode).toBe(200);
    const settled = OrderRepository.getById(orderId);
    expect(settled.status).toBe('preempted');
    // 60min 予約・ほぼ即時 preempt → 課金は最初の 5 分粒度のみ（全額 60 のままなら失敗）
    expect(settled.totalPrice).toBeLessThan(60);
    expect(preempt.body.settlement.chargeableMinutes).toBeLessThanOrEqual(10);
  });

  it('a preempted order rejects further heartbeats (no continued billing)', async () => {
    const preempted = OrderRepository.getAll().find((o) => o.status === 'preempted');
    expect(preempted).toBeTruthy();
    const hb = await request(app).post(`/api/v1/orders/${preempted.id}/heartbeat`)
      .set('Authorization', `Bearer ${provider.token}`)
      .send({ role: 'lender' });
    expect(hb.statusCode).toBeGreaterThanOrEqual(400);
  });
});
