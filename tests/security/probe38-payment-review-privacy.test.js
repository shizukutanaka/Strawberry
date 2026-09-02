// tests/security/probe38-payment-review-privacy.test.js
// Probe 38 regression tests:
// 38a-1: (removed 2026-09 — the btc-onchain route it guarded no longer exists)
// 38a-2: Manual payment approval checks order status (no orphaned paid records)
// 38b-1: renter profile (trust-summary) recentReviews does not include orderId
// 38b-3: (removed 2026-09 — GET /users/me/activity no longer exists)

const request = require('supertest');
const { app } = require('../../src/api/server');

const uniq = `p38${Date.now().toString(36)}`;

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 38a-1: (削除) BTC on-chain の注文状態ゲート ─────────────────────────
// POST /payment/btc ごと削除したためこの検査は不要になった（2026-09）。二重課金の
// 心配自体が、決済経路を Lightning 1 本にしたことで消えている。

// ─── 38a-2: Manual payment approval order-status guard ───────────────────────
describe('Manual payment approval: order status guard', () => {
  it('payment/index.js: manual approve reads order and checks status', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/payment/index.js'), 'utf-8'
    );
    expect(src).toMatch(/payment\.orderId/);
    expect(src).toMatch(/OrderRepository\.getById\(payment\.orderId\)/);
    expect(src).toMatch(/pending.*matched.*order.status|order.status.*pending.*matched/);
  });

  it('POST /payment/manual/approve returns 401 without admin token', async () => {
    const res = await request(app)
      .post('/api/v1/payment/manual/approve/nonexistent-id')
      .send({});
    expect([401, 403]).toContain(res.statusCode);
  });
});

// ─── 38b-1: renter profile does not leak orderId ─────────────────────────────
// 2026-09: GET /users/:id/renter-profile は削除。同じ集計は GET /orders/:id の
// renterProfile に埋め込まれ、計算は src/reputation/trust-summary.js にある。
describe('renterSummary: orderId stripped from recentReviews', () => {
  it('trust-summary.js: recentReviews map does not include orderId', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/reputation/trust-summary.js'), 'utf-8'
    );
    const mapIdx = src.indexOf('.map(o => ({ rating: o.renterReview.rating');
    expect(mapIdx).toBeGreaterThan(-1);
    const mapBlock = src.slice(mapIdx, mapIdx + 200);
    expect(mapBlock).not.toMatch(/orderId.*o\.id/);
  });

  it('renterSummary: recentReviews entries have no orderId', async () => {
    const name = `p38rp${uniq}`.slice(0, 20);
    const email = `${name}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username: name, email, password: 'Test1234!' });
    const UserRepository = require('../../src/db/json/UserRepository');
    const OrderRepository = require('../../src/db/json/OrderRepository');
    const userId = UserRepository.getByEmail(email).id;
    const order = OrderRepository.create({
      userId, providerId: 'p38-provider', gpuId: 'p38-gpu', status: 'completed', durationMinutes: 30,
      renterReview: { rating: 4, comment: 'fine', reviewerId: 'p38-provider', reviewedAt: new Date().toISOString() },
    });
    const { renterSummary } = require('../../src/reputation/trust-summary');
    const profile = renterSummary(userId);
    expect(profile.reviewCount).toBe(1);
    expect(profile.recentReviews.length).toBe(1);
    for (const r of profile.recentReviews) {
      expect(r).not.toHaveProperty('orderId');
      expect(JSON.stringify(r)).not.toContain(order.id);
    }
  });
});

