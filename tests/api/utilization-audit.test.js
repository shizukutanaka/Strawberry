// tests/api/utilization-audit.test.js
// ゼロ負荷課金の検出が「実レンタルフロー」で動くこと（研究ドキュメント §1）。
//
// 着手前は work-verifier.detectZeroLoad() は実装済みでも、入力 utilSamples は admin が
// /escrow/:id/verify のボディで手渡す経路しか無く、実際のレンタルからは一度も呼ばれて
// いなかった。ここではハートビート経由で集めた値が終了時に判定へ流れることを確認する。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');
const PaymentRepository = require('../../src/db/json/PaymentRepository');
const uc = require('../../src/verification/utilization-collector');

const uniq = Date.now().toString(36);
let providerTok, providerId, renterTok, renterId;

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
  const p = await mkUser('utilprov', 'provider'); providerTok = p.token; providerId = p.id;
  const r = await mkUser('utilrent'); renterTok = r.token; renterId = r.id;
});

// active な注文と、/stop が要求する paid 決済レコードを用意する
function seedActiveOrder() {
  const gpu = GpuRepository.create({
    name: `Util GPU ${Math.random().toString(36).slice(2, 8)}`,
    vendor: 'NVIDIA', model: 'RTX 4090', apiType: 'CUDA',
    memoryGB: 24, clockMHz: 2500, powerWatt: 450, pricePerHour: 1000,
    providerId, available: true,
  });
  const order = OrderRepository.create({
    userId: renterId, providerId, gpuId: gpu.id, durationMinutes: 60,
    status: 'active', pricePerHour: 1000, totalPrice: 1000,
    startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  PaymentRepository.create({ orderId: order.id, userId: renterId, amount: 1000, method: 'bank_transfer', status: 'paid' });
  return { gpu, order };
}

const stop = (orderId) => request(app).post(`/api/v1/orders/${orderId}/stop`)
  .set('Authorization', `Bearer ${renterTok}`);

describe('heartbeat carries utilization telemetry', () => {
  it('accepts an optional utilizationPct and reports that it was recorded', async () => {
    const { order } = seedActiveOrder();
    const res = await request(app).post(`/api/v1/orders/${order.id}/heartbeat`)
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ role: 'lender', utilizationPct: 87 });
    expect(res.status).toBe(200);
    expect(res.body.utilizationRecorded).toBe(true);
    expect(uc.getSamples(order.id).lender).toEqual([87]);
    uc.clear(order.id);
  });

  it('still succeeds without telemetry (backwards compatible)', async () => {
    const { order } = seedActiveOrder();
    const res = await request(app).post(`/api/v1/orders/${order.id}/heartbeat`)
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ role: 'lender' });
    expect(res.status).toBe(200);
    expect(res.body.utilizationRecorded).toBe(false);
  });

  it('ignores a malformed value instead of failing the heartbeat', async () => {
    // ハートビートは稼働の生命線。テレメトリの型ミスで落としてはならない。
    const { order } = seedActiveOrder();
    const res = await request(app).post(`/api/v1/orders/${order.id}/heartbeat`)
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ role: 'lender', utilizationPct: 'ninety' });
    expect(res.status).toBe(200);
    expect(res.body.utilizationRecorded).toBe(false);
    expect(uc.getSamples(order.id).lender).toEqual([]);
  });
});

describe('audit at termination', () => {
  // 判定に必要な最小サンプル数ぶんを直接注入する（ハートビートは 10 秒間隔制限があるため）
  const feed = (orderId, role, value, n = uc.MIN_SAMPLES_FOR_VERDICT) => {
    for (let i = 0; i < n; i++) uc.record(orderId, role, value);
  };

  it('records zero_load when both sides agree the GPU was idle, and flags it to the renter', async () => {
    const { order } = seedActiveOrder();
    feed(order.id, 'lender', 0);
    feed(order.id, 'renter', 0);

    expect((await stop(order.id)).status).toBe(200);
    const after = OrderRepository.getById(order.id);
    expect(after.utilizationAudit.verdict).toBe('zero_load');
    // 判定に使ったサンプルは終了時に破棄される（プロセス内に残さない）
    expect(uc.getSamples(order.id)).toEqual({ lender: [], renter: [] });
  });

  it('records disputed when the two sides disagree, without picking a side', async () => {
    const { order } = seedActiveOrder();
    feed(order.id, 'lender', 90);
    feed(order.id, 'renter', 0);

    await stop(order.id);
    const after = OrderRepository.getById(order.id);
    expect(after.utilizationAudit.verdict).toBe('disputed');
    // どちらが正しいかを断定するフィールドは持たない
    expect(after.utilizationAudit.blame).toBeUndefined();
  });

  it('records active when work was actually running', async () => {
    const { order } = seedActiveOrder();
    feed(order.id, 'lender', 80);
    feed(order.id, 'renter', 80);

    await stop(order.id);
    expect(OrderRepository.getById(order.id).utilizationAudit.verdict).toBe('active');
  });

  it('stores nothing when there was no telemetry at all', async () => {
    // no_data を保存すると「検証した結果シロ」と読めてしまう
    const { order } = seedActiveOrder();
    await stop(order.id);
    expect(OrderRepository.getById(order.id).utilizationAudit).toBeUndefined();
  });

  it('never blocks settlement on the audit verdict', async () => {
    // 判定は証拠であって裁定ではない。zero_load でも注文は完了し、資金は自動で動かさない。
    const { order } = seedActiveOrder();
    feed(order.id, 'lender', 0);
    feed(order.id, 'renter', 0);

    const res = await stop(order.id);
    expect(res.status).toBe(200);
    expect(OrderRepository.getById(order.id).status).toBe('completed');
  });

  it('feeds the provider reputation audit counters', async () => {
    const { createReputationService } = require('../../src/reputation/reputation-service');
    const rep = createReputationService();
    const before = rep.getStats(providerId);

    const { order } = seedActiveOrder();
    feed(order.id, 'lender', 0);
    feed(order.id, 'renter', 0);
    await stop(order.id);

    const after = rep.getStats(providerId);
    expect(after.auditFails).toBe(before.auditFails + 1);
  });

  it('does not count a disputed verdict against either party', async () => {
    // 食い違いは「提供者が不正」を意味しない。借り手が偽った可能性も同じだけある。
    const { createReputationService } = require('../../src/reputation/reputation-service');
    const rep = createReputationService();
    const before = rep.getStats(providerId);

    const { order } = seedActiveOrder();
    feed(order.id, 'lender', 90);
    feed(order.id, 'renter', 0);
    await stop(order.id);

    const after = rep.getStats(providerId);
    expect(after.auditFails).toBe(before.auditFails);
    expect(after.auditPasses).toBe(before.auditPasses);
  });
});
