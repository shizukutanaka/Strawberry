// tests/api/trust-summary.test.js
// 取引相手の信頼度が、ユーザー ID を画面に出さずに製品の 2 箇所へ届くこと:
//   - GET /gpus/:id   → providerReputation（公開。providerId は含まない）
//   - GET /orders/:id → renterProfile（当事者のみ。無効な評価値は除外）
// 以前は /users/:id/reputation と /users/:id/renter-profile という独立ルートだったが、
// UI はユーザー ID を持たないので一度も呼べなかった。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');
const { providerSummary, renterSummary } = require('../../src/reputation/trust-summary');

const uniq = `ts${Date.now().toString(36)}`;
async function makeUser(prefix, role) {
  const name = `${prefix}${uniq}`.slice(0, 20);
  const email = `${name}@example.com`;
  await request(app).post('/api/v1/users/register').send({ username: name, email, password: 'Test1234!' });
  const u = UserRepository.getByEmail(email);
  if (role) UserRepository.update(u.id, { role });
  const token = (await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' })).body.token;
  return { id: u.id, token };
}

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise((done) => (server && server.close ? server.close(() => done()) : done()));
});

describe('provider trust on the GPU detail', () => {
  let provider, renter, gpu;
  beforeAll(async () => {
    provider = await makeUser('tsprov', 'provider');
    renter = await makeUser('tsrent');
    gpu = GpuRepository.create({ name: 'Trust GPU', vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24, pricePerHour: 100, providerId: provider.id });
    // 完了 1 件（★5）・拒否 1 件
    OrderRepository.create({ userId: renter.id, providerId: provider.id, gpuId: gpu.id, status: 'completed', durationMinutes: 60,
      review: { rating: 5, comment: 'great', reviewerId: renter.id, reviewedAt: new Date().toISOString() } });
    OrderRepository.create({ userId: renter.id, providerId: provider.id, gpuId: gpu.id, status: 'cancelled', cancelReason: 'provider_rejected', durationMinutes: 60 });
  });

  it('is public, carries the track record, and does not leak providerId', async () => {
    const res = await request(app).get(`/api/v1/gpus/${gpu.id}`);
    expect(res.statusCode).toBe(200);
    const rep = res.body.gpu.providerReputation;
    expect(rep).toBeTruthy();
    expect(rep).toMatchObject({ completedOrders: 1, rejectedOrders: 1, ratingAverage: 5, reviewCount: 1 });
    expect(typeof rep.score).toBe('number');
    expect(typeof rep.tier).toBe('string');
    expect(rep).not.toHaveProperty('providerId');
    expect(res.body.gpu).not.toHaveProperty('providerId');
  });

  it('is null when the provider account is gone (not a crash, not a fake profile)', () => {
    expect(providerSummary('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('renter trust on the order detail', () => {
  it('excludes a corrupted rating instead of counting it as ★1 (the bug the order route used to have)', async () => {
    const provider = await makeUser('tsprov2', 'provider');
    const renter = await makeUser('tsrent2');
    const gpu = GpuRepository.create({ name: 'Trust GPU 2', vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24, pricePerHour: 100, providerId: provider.id });
    OrderRepository.create({ userId: renter.id, providerId: 'other', gpuId: 'x', status: 'completed', durationMinutes: 30,
      renterReview: { rating: 5, reviewerId: 'other', reviewedAt: '2026-01-01T00:00:00.000Z' } });
    OrderRepository.create({ userId: renter.id, providerId: 'other2', gpuId: 'y', status: 'completed', durationMinutes: 30,
      renterReview: { rating: undefined, reviewerId: 'other2', reviewedAt: '2026-01-02T00:00:00.000Z' } }); // 破損レコード
    const order = OrderRepository.create({ userId: renter.id, providerId: provider.id, gpuId: gpu.id, status: 'pending', durationMinutes: 30 });

    const res = await request(app).get(`/api/v1/orders/${order.id}`).set('Authorization', `Bearer ${provider.token}`);
    expect(res.statusCode).toBe(200);
    // 旧実装: (5 + 1) / 2 = 3。正: 壊れた値は数えない → 5 / 1 件。
    expect(res.body.order.renterProfile).toMatchObject({ ratingAverage: 5, reviewCount: 1, completedOrders: 2 });
    expect(res.body.order.renterProfile.recentReviews[0]).not.toHaveProperty('orderId');
    // 直接呼んでも同じ（一箇所で計算している）
    expect(renterSummary(renter.id)).toMatchObject({ ratingAverage: 5, reviewCount: 1 });
  });
});
