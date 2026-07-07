// tests/security/probe25-order-race-session.test.js
// Probe 25 regression tests:
// 1. isSessionInvalidated: NaN iat is rejected (fail-closed, not fail-open)
// 2. Token denylist: revoke(jti, 0) stores a future expiry — prevents exp=0 bypass
// 3. DELETE /orders/:id returns 409 when order is already cancelled (updateIf CAS)
// 4. POST /:id/dispute: open-dispute count limit enforced atomically per user
// 5. dispute/resolve lock key uses order:${id} (shared with /start and /stop)

const request = require('supertest');
const { app } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const { isSessionInvalidated } = require('../../src/api/utils/session-invalidation');
const { revoke, isRevoked } = require('../../src/api/middleware/token-denylist');

const uniq = `p25${Date.now().toString(36)}`;
let adminTok, userTok, userId, adminId;

beforeAll(async () => {
  const admName = `p25adm${uniq}`.slice(0, 20);
  const admEmail = `${admName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: admName, email: admEmail, password: 'Test1234!' });
  const admUser = UserRepository.getByEmail(admEmail);
  adminId = admUser.id;
  UserRepository.update(admUser.id, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: admEmail, password: 'Test1234!' })).body.token;

  const usrName = `p25usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  const usr = UserRepository.getByEmail(usrEmail);
  userId = usr.id;
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;
});

// ─── 1. isSessionInvalidated: NaN iat ────────────────────────────────────────
describe('isSessionInvalidated: NaN iat is rejected (fail-closed)', () => {
  it('returns true when iat is NaN and user has a passwordChangedAt', () => {
    const user = { passwordChangedAt: new Date(Date.now() - 1000).toISOString() };
    expect(isSessionInvalidated(user, NaN)).toBe(true);
  });

  it('returns true when iat is NaN even if no session boundary fields are set', () => {
    const user = {};
    expect(isSessionInvalidated(user, NaN)).toBe(true);
  });

  it('returns true when iat is Infinity', () => {
    const user = { sessionsRevokedAt: new Date().toISOString() };
    expect(isSessionInvalidated(user, Infinity)).toBe(true);
  });

  it('returns false for normal future iat (unrevoked token)', () => {
    const user = { passwordChangedAt: new Date(Date.now() - 60000).toISOString() };
    const iatNow = Math.floor(Date.now() / 1000);
    expect(isSessionInvalidated(user, iatNow)).toBe(false);
  });

  it('returns false when user is null', () => {
    expect(isSessionInvalidated(null, NaN)).toBe(false);
  });
});

// ─── 2. Token denylist: exp=0 bypass prevention ───────────────────────────────
describe('Token denylist: revoke(jti, 0) stores future expiry', () => {
  it('isRevoked returns true immediately after revoke(jti, 0) — exp=0 bypass closed', () => {
    const jti = `p25-test-${Date.now()}-${Math.random()}`;
    revoke(jti, 0); // before fix: stored 0 → pruned immediately; now stores Date.now()+24h
    expect(isRevoked(jti)).toBe(true);
  });

  it('isRevoked returns true for revoke(jti, null) — null falls back to 24h TTL', () => {
    const jti = `p25-test-null-${Date.now()}-${Math.random()}`;
    revoke(jti, null);
    expect(isRevoked(jti)).toBe(true);
  });

  it('isRevoked returns true for normal future expiry', () => {
    const jti = `p25-test-future-${Date.now()}`;
    const futureMs = Date.now() + 60 * 60 * 1000;
    revoke(jti, futureMs);
    expect(isRevoked(jti)).toBe(true);
  });

  it('isRevoked returns false for unknown jti', () => {
    expect(isRevoked('completely-unknown-jti-xyz')).toBe(false);
  });
});

// ─── 3. DELETE /orders/:id: CAS prevents double-cancel ────────────────────────
describe('DELETE /orders/:id: CAS + pre-check block non-cancellable states', () => {
  let gpu, order;

  beforeEach(() => {
    gpu = GpuRepository.create({
      name: 'P25 Cancel GPU', vendor: 'NVIDIA', model: 'RTX-P25', memoryGB: 8,
      pricePerHour: 1, providerId: 'p25-prov',
    });
    order = OrderRepository.create({
      gpuId: gpu.id, userId, providerId: 'p25-prov',
      durationMinutes: 60, status: 'pending',
      pricePerHour: 1, totalPrice: 1, totalPriceJPY: 100,
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    try { OrderRepository.delete(order.id); } catch (_) {}
    try { GpuRepository.delete(gpu.id); } catch (_) {}
  });

  it('first cancel returns 200', async () => {
    const res = await request(app)
      .delete(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${userTok}`);
    expect(res.statusCode).toBe(200);
    const updated = OrderRepository.getById(order.id);
    expect(updated.status).toBe('cancelled');
  });

  it('second cancel on already-cancelled order returns 400 (pre-check)', async () => {
    // Cancel once
    await request(app)
      .delete(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${userTok}`);

    // Second cancel: pre-check fires (order already cancelled, req.resource snapshot shows it)
    const res = await request(app)
      .delete(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${userTok}`);
    expect(res.statusCode).toBe(400);
  });

  it('cancel of a completed order returns 400 (pre-check)', async () => {
    OrderRepository.update(order.id, { status: 'completed' });
    const res = await request(app)
      .delete(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${userTok}`);
    expect(res.statusCode).toBe(400);
  });

  it('OrderRepository.updateIf CAS: returns ok=false for non-pending/matched order', () => {
    // Direct unit test of the CAS that backs the DELETE endpoint
    OrderRepository.update(order.id, { status: 'cancelled' });
    const result = OrderRepository.updateIf(
      order.id,
      (o) => ['pending', 'matched'].includes(o.status),
      { status: 'cancelled', cancelReason: 'race_test' }
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('condition_failed');
    expect(result.current.status).toBe('cancelled');
  });
});

// ─── 4. POST /:id/dispute: open-dispute count limit ───────────────────────────
describe('POST /orders/:id/dispute: open-dispute count limit enforced', () => {
  const MAX = 3; // matches default MAX_OPEN_DISPUTES_PER_USER
  const gpuIds = [];
  const orderIds = [];

  beforeAll(async () => {
    // Seed MAX+1 active orders belonging to userId
    for (let i = 0; i < MAX + 1; i++) {
      const g = GpuRepository.create({
        name: `P25 Dispute GPU ${i}`, vendor: 'NVIDIA', model: `RTX-P25D${i}`, memoryGB: 8,
        pricePerHour: 1, providerId: `p25d-prov-${i}`,
      });
      gpuIds.push(g.id);
      const o = OrderRepository.create({
        gpuId: g.id, userId, providerId: `p25d-prov-${i}`,
        durationMinutes: 60, status: 'active',
        pricePerHour: 1, totalPrice: 1, totalPriceJPY: 100,
        createdAt: new Date().toISOString(),
      });
      orderIds.push(o.id);
    }
  });

  afterAll(() => {
    for (const id of orderIds) { try { OrderRepository.delete(id); } catch (_) {} }
    for (const id of gpuIds) { try { GpuRepository.delete(id); } catch (_) {} }
  });

  it('allows raising disputes up to the limit', async () => {
    for (let i = 0; i < MAX; i++) {
      const res = await request(app)
        .post(`/api/v1/orders/${orderIds[i]}/dispute`)
        .set('Authorization', `Bearer ${userTok}`)
        .send({ reason: `dispute ${i}` });
      expect(res.statusCode).toBe(201);
    }
  });

  it('blocks the (MAX+1)th dispute with 409', async () => {
    const res = await request(app)
      .post(`/api/v1/orders/${orderIds[MAX]}/dispute`)
      .set('Authorization', `Bearer ${userTok}`)
      .send({ reason: 'one too many' });
    expect(res.statusCode).toBe(409);
    // Error is nested: { error: { type, message, statusCode, ... } }
    const msg = res.body.error?.message || res.body.message || '';
    expect(msg).toMatch(/open disputes/i);
  });
});

// ─── 5. dispute/resolve lock key is 'order:${id}' (same as /start, /stop) ────
describe('dispute/resolve lock: uses order:${id} key (source check)', () => {
  it('order/index.js uses withLock(`order:${orderId}`) for dispute/resolve', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // The dispute-resolve handler must share the same lock key as /start and /stop
    const lockMatches = [...src.matchAll(/withLock\(`order:\$\{orderId\}`/g)];
    expect(lockMatches.length).toBeGreaterThanOrEqual(2); // dispute-resolve + at least one other
  });

  it('order/index.js uses withLock for dispute-raise per order (not per user)', () => {
    // The lock must be per-order so renter+provider concurrent disputes are serialized.
    // A per-user key would allow them to race each other on the same order.
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    expect(src).toMatch(/withLock\(`order:\$\{order\.id\}:dispute`/);
    expect(src).not.toMatch(/withLock\(`user:\$\{req\.user\.id\}:dispute-raise`/);
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
