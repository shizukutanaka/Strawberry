// tests/api/spot-tier.test.js
// Spot（中断許容）ティアの API 経路。
//
// 最重要は「プロバイダに中断を許すことで zero-work theft の穴を開けていないか」。
// /stop がプロバイダに禁止されているのは、0 秒の労働で全額を回収されるのを防ぐため。
// spot はプロバイダによる打ち切りを仕様として認めるので、その穴を
//   (1) spot 注文限定 (2) 猶予窓 (3) 最低課金を効かせない従量按分
// の 3 点で塞げているかを検証する。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');
const { finalizePreemptedOrders } = require('../../src/utils/order-expiry');

const uniq = Date.now().toString(36);
let providerTok, providerId, renterTok, renterId, otherTok, adminTok;

async function mkUser(prefix, role) {
  const name = `${prefix}${uniq}`.slice(0, 20);
  const email = `${name}@example.com`;
  await request(app).post('/api/v1/users/register').send({ username: name, email, password: 'Test1234!' });
  const u = UserRepository.getByEmail(email);
  if (role) UserRepository.update(u.id, { role });
  const token = (await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' })).body.token;
  return { id: u.id, token };
}

beforeAll(async () => {
  const p = await mkUser('spotprov', 'provider'); providerTok = p.token; providerId = p.id;
  const r = await mkUser('spotrent'); renterTok = r.token; renterId = r.id;
  const o = await mkUser('spotother'); otherTok = o.token;
  const a = await mkUser('spotadmin', 'admin'); adminTok = a.token;
});

const mkGpu = (over = {}) => GpuRepository.create({
  name: `Spot GPU ${Math.random().toString(36).slice(2, 8)}`,
  vendor: 'NVIDIA', model: 'RTX 4090', apiType: 'CUDA',
  memoryGB: 24, clockMHz: 2500, powerWatt: 450, pricePerHour: 1000,
  providerId, available: true, ...over,
});

const createOrder = (gpuId, body = {}) => request(app).post('/api/v1/orders')
  .set('Authorization', `Bearer ${renterTok}`)
  .send({ gpuId, durationMinutes: 60, ...body });

describe('spot pricing at order creation', () => {
  it('discounts a spot order and locks the agreed terms onto it', async () => {
    const gpu = mkGpu({ spotEnabled: true, spotDiscountPct: 40, spotNoticeSeconds: 60 });
    const res = await createOrder(gpu.id, { tier: 'spot' });
    expect(res.status).toBe(201);

    const order = OrderRepository.getById(res.body.orderId);
    expect(order.tier).toBe('spot');
    expect(order.pricePerHour).toBe(600);          // 1000 の 40% 引き
    expect(order.totalPrice).toBe(600);            // 60 分
    // 出品側が後から条件を変えても既存注文の精算が動かないよう、合意時点の条件を固定する
    expect(order.spotDiscountPct).toBe(40);
    expect(order.listPricePerHour).toBe(1000);
    expect(order.spotNoticeSeconds).toBe(60);
  });

  it('charges the full rate for an on-demand order on the same GPU', async () => {
    const gpu = mkGpu({ spotEnabled: true, spotDiscountPct: 40 });
    const res = await createOrder(gpu.id);
    const order = OrderRepository.getById(res.body.orderId);
    expect(order.tier).toBe('ondemand');
    expect(order.totalPrice).toBe(1000);
  });

  it('rejects spot on a listing that has not opted in, instead of silently charging full price', async () => {
    const gpu = mkGpu({ spotEnabled: false });
    const res = await createOrder(gpu.id, { tier: 'spot' });
    expect(res.status).toBe(400);
    expect(res.body.error.message || res.body.error).toMatch(/spot/i);
  });

  it('rejects an unknown tier at the schema boundary', async () => {
    const gpu = mkGpu({ spotEnabled: true });
    expect((await createOrder(gpu.id, { tier: 'free' })).status).toBe(400);
  });
});

describe('GET /gpus exposes the spot offer', () => {
  it('reports the discounted effective price so renters can compare the trade', async () => {
    const gpu = mkGpu({ spotEnabled: true, spotDiscountPct: 60, spotNoticeSeconds: 90 });
    const res = await request(app).get(`/api/v1/gpus/${gpu.id}`);
    expect(res.status).toBe(200);
    expect(res.body.gpu.spot).toMatchObject({
      enabled: true, discountPct: 60, noticeSeconds: 90, pricePerHour: 400,
    });
    // 割引の代償がどれくらいの頻度で現実になるかを開示する
    expect(res.body.gpu.spot.providerPreemptionRate).toBeDefined();
  });

  it('says enabled:false for a listing that does not offer spot', async () => {
    const gpu = mkGpu({});
    const res = await request(app).get(`/api/v1/gpus/${gpu.id}`);
    expect(res.body.gpu.spot).toEqual({ enabled: false });
  });
});

describe('POST /orders/:id/preempt', () => {
  // 注文を active まで進める（決済経路を通さず直接遷移させる — ここでの関心は中断側）
  function seedActiveOrder(over = {}) {
    const gpu = mkGpu({ spotEnabled: true, spotDiscountPct: 50, spotNoticeSeconds: 60 });
    const order = OrderRepository.create({
      userId: renterId, providerId, gpuId: gpu.id, durationMinutes: 60,
      status: 'active', tier: 'spot', spotNoticeSeconds: 60,
      pricePerHour: 500, totalPrice: 500,
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      ...over,
    });
    return { gpu, order };
  }

  it('lets the provider issue a notice with a grace window instead of killing instantly', async () => {
    const { order } = seedActiveOrder();
    const res = await request(app).post(`/api/v1/orders/${order.id}/preempt`)
      .set('Authorization', `Bearer ${providerTok}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('preempting');
    expect(res.body.noticeSeconds).toBe(60);

    const after = OrderRepository.getById(order.id);
    expect(after.status).toBe('preempting');
    const grace = Date.parse(after.preemptionDeadlineAt) - Date.parse(after.preemptionNoticeAt);
    expect(grace).toBe(60 * 1000);
  });

  it('refuses to preempt an on-demand order — that would reopen zero-work theft', async () => {
    const { order } = seedActiveOrder({ tier: 'ondemand' });
    const res = await request(app).post(`/api/v1/orders/${order.id}/preempt`)
      .set('Authorization', `Bearer ${providerTok}`);
    expect(res.status).toBe(400);
    expect(OrderRepository.getById(order.id).status).toBe('active');
  });

  it('refuses callers who are neither the provider nor an admin', async () => {
    const { order } = seedActiveOrder();
    expect((await request(app).post(`/api/v1/orders/${order.id}/preempt`)
      .set('Authorization', `Bearer ${otherTok}`)).status).toBe(403);
    // 借り手も中断はできない（借り手には /stop がある）
    expect((await request(app).post(`/api/v1/orders/${order.id}/preempt`)
      .set('Authorization', `Bearer ${renterTok}`)).status).toBe(403);
    expect((await request(app).post(`/api/v1/orders/${order.id}/preempt`)).status).toBe(401);
    expect(OrderRepository.getById(order.id).status).toBe('active');
  });

  it('does not let a repeated notice keep pushing the deadline out', async () => {
    const { order } = seedActiveOrder();
    await request(app).post(`/api/v1/orders/${order.id}/preempt`).set('Authorization', `Bearer ${providerTok}`);
    const firstDeadline = OrderRepository.getById(order.id).preemptionDeadlineAt;
    const second = await request(app).post(`/api/v1/orders/${order.id}/preempt`)
      .set('Authorization', `Bearer ${providerTok}`);
    expect(second.status).toBe(409);
    expect(OrderRepository.getById(order.id).preemptionDeadlineAt).toBe(firstDeadline);
  });

  it('only preempts an active order', async () => {
    const { order } = seedActiveOrder({ status: 'pending' });
    expect((await request(app).post(`/api/v1/orders/${order.id}/preempt`)
      .set('Authorization', `Bearer ${providerTok}`)).status).toBe(400);
  });

  it('lets an admin preempt too', async () => {
    const { order } = seedActiveOrder();
    expect((await request(app).post(`/api/v1/orders/${order.id}/preempt`)
      .set('Authorization', `Bearer ${adminTok}`)).status).toBe(200);
  });

  it('keeps the GPU blocked while preempting so it cannot be double-booked', async () => {
    const { gpu, order } = seedActiveOrder();
    await request(app).post(`/api/v1/orders/${order.id}/preempt`).set('Authorization', `Bearer ${providerTok}`);
    const conflict = await createOrder(gpu.id);
    expect(conflict.status).toBe(409);
  });

  it('finalizes with strict pro-rata once the grace window closes', async () => {
    const { order } = seedActiveOrder();
    await request(app).post(`/api/v1/orders/${order.id}/preempt`).set('Authorization', `Bearer ${providerTok}`);
    // 猶予切れを模す
    OrderRepository.update(order.id, { preemptionDeadlineAt: new Date(Date.now() - 1000).toISOString() });

    const finalized = finalizePreemptedOrders();
    expect(finalized.some((f) => f.id === order.id)).toBe(true);

    const after = OrderRepository.getById(order.id);
    expect(after.status).toBe('completed');
    expect(after.terminationReason).toBe('preempted');
    // 30 分稼働していたので約 1800 秒
    expect(after.deliveredSeconds).toBeGreaterThan(1700);
    expect(after.deliveredSeconds).toBeLessThan(1900);
  });

  it('is idempotent — finalizing twice does not re-complete the order', async () => {
    const { order } = seedActiveOrder();
    await request(app).post(`/api/v1/orders/${order.id}/preempt`).set('Authorization', `Bearer ${providerTok}`);
    OrderRepository.update(order.id, { preemptionDeadlineAt: new Date(Date.now() - 1000).toISOString() });
    finalizePreemptedOrders();
    const second = finalizePreemptedOrders();
    expect(second.some((f) => f.id === order.id)).toBe(false);
  });

  it('does not leave an order stuck in preempting when the deadline is unparseable', async () => {
    // 壊れた値で永久に preempting に留まると GPU がロックされ続ける
    const { order } = seedActiveOrder();
    OrderRepository.update(order.id, { status: 'preempting', preemptionDeadlineAt: 'not-a-date' });
    finalizePreemptedOrders();
    expect(OrderRepository.getById(order.id).status).toBe('completed');
  });
});
