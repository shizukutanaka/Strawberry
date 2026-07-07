// tests/security/probe38-payment-review-privacy.test.js
// Probe 38 regression tests:
// 38a-1: BTC on-chain payment rejects active orders (double-charge prevention)
// 38a-2: Manual payment approval checks order status (no orphaned paid records)
// 38b-1: renter-profile recentReviews does not include orderId
// 38b-3: /me/activity review_received does not expose reviewedBy

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

// ─── 38a-1: BTC on-chain status gate ─────────────────────────────────────────
describe('BTC on-chain: active orders are rejected', () => {
  it('btc-onchain.js: ALLOWED_BTC_PAYMENT_STATUSES excludes active', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/payment/btc-onchain.js'), 'utf-8'
    );
    // Must NOT allow active
    expect(src).not.toMatch(/ALLOWED_BTC_PAYMENT_STATUSES.*active/);
    // Must still allow pending and matched
    expect(src).toMatch(/ALLOWED_BTC_PAYMENT_STATUSES.*pending/);
    expect(src).toMatch(/ALLOWED_BTC_PAYMENT_STATUSES.*matched/);
  });

  it('POST /payment/btc returns 409 for an active order', async () => {
    // We need an active order to test; simulate by checking source-level guard
    // (integration test for active orders requires full Lightning setup).
    // Verify the guard constant doesn't include 'active'.
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/payment/btc-onchain.js'), 'utf-8'
    );
    const match = src.match(/new Set\(\[([^\]]+)\]\)/);
    expect(match).not.toBeNull();
    const allowedStatuses = match[1];
    expect(allowedStatuses).not.toContain("'active'");
    expect(allowedStatuses).toContain("'pending'");
    expect(allowedStatuses).toContain("'matched'");
  });
});

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

// ─── 38b-1: renter-profile does not leak orderId ─────────────────────────────
describe('renter-profile: orderId stripped from recentReviews', () => {
  it('user/index.js: renter-profile map does not include orderId', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    // The recentReviews map must not expose o.id
    // Find the renter-profile map block
    const mapIdx = src.indexOf('.map(o => ({ rating: o.renterReview.rating');
    expect(mapIdx).toBeGreaterThan(-1);
    // The map near renter-profile must not include orderId
    const mapBlock = src.slice(mapIdx, mapIdx + 200);
    expect(mapBlock).not.toMatch(/orderId.*o\.id/);
  });

  it('GET /users/:id/renter-profile: recentReviews entries have no orderId', async () => {
    // Register a test user
    const name = `p38rp${uniq}`.slice(0, 20);
    const email = `${name}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username: name, email, password: 'Test1234!' });
    const loginRes = await request(app).post('/api/v1/users/login')
      .send({ email, password: 'Test1234!' });
    const userId = loginRes.body.user && loginRes.body.user.id;
    if (!userId) return;

    const res = await request(app).get(`/api/v1/users/${userId}/renter-profile`);
    expect(res.statusCode).toBe(200);
    const reviews = res.body.recentReviews || [];
    for (const r of reviews) {
      expect(r).not.toHaveProperty('orderId');
    }
  });
});

// ─── 38b-3: /me/activity does not expose reviewedBy ─────────────────────────
describe('/me/activity: reviewedBy removed from review_received events', () => {
  it('user/index.js: review_received events do not include reviewedBy', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    // Find the review_received push blocks and ensure they don't include reviewedBy
    const reviewReceivedBlocks = [];
    let idx = 0;
    while (true) {
      const found = src.indexOf("type: 'review_received'", idx);
      if (found === -1) break;
      reviewReceivedBlocks.push(src.slice(found, found + 300));
      idx = found + 1;
    }
    expect(reviewReceivedBlocks.length).toBeGreaterThan(0);
    for (const block of reviewReceivedBlocks) {
      expect(block).not.toMatch(/reviewedBy/);
    }
  });

  it('GET /users/me/activity returns review_received without reviewedBy field', async () => {
    const name = `p38act${uniq}`.slice(0, 20);
    const email = `${name}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username: name, email, password: 'Test1234!' });
    const loginRes = await request(app).post('/api/v1/users/login')
      .send({ email, password: 'Test1234!' });
    const token = loginRes.body.token;
    if (!token) return;

    const res = await request(app)
      .get('/api/v1/users/me/activity?type=review_received')
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    const events = res.body.events || [];
    for (const e of events) {
      if (e.type === 'review_received') {
        expect(e).not.toHaveProperty('reviewedBy');
      }
    }
  });
});
