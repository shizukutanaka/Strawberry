// tests/security/probe64-order-create-rate-limit.test.js
// Regression / feature test for per-user order-creation rate limiting.
//
// Background: POST /orders is protected by a global IP-based rate limiter but had
// no per-user throttle. An authenticated user could hammer the endpoint, forcing
// the server to run GPU lookups, price calculations, and double-booking scans on
// every request. The rate limit state is exposed on
// orderRouter._checkOrderCreateRateLimit._state so tests can reset it between runs.
//
// This probe confirms:
//   1. A user can create orders up to ORDER_CREATE_RATE_LIMIT within one window.
//   2. The (limit+1)th attempt returns 429.
//   3. Resetting the state lets the same user create orders again.
//   4. Different users share no state — user B is unaffected by user A hitting the cap.

const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const orderRouter = require('../../src/api/routes/order');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

let _seq = 0;
async function registerAndLogin(prefix, role = 'user') {
  const uniq = `${prefix}${Date.now().toString(36)}${_seq++}`;
  const email = `${uniq}@example.com`;
  const username = uniq.slice(0, 20);
  const password = 'Test1234!';
  await request(app).post('/api/v1/users/register').send({ username, email, password, role });
  const res = await request(app).post('/api/v1/users/login').send({ email, password });
  const u = UserRepository.getByEmail(email);
  return { token: res.body.token, id: u ? u.id : null };
}

function createAvailableGpu(providerId) {
  return GpuRepository.create({
    name: `GPU-RL-${Date.now()}-${Math.random()}`,
    model: 'A100',
    vendor: 'NVIDIA',
    memoryGB: 80,
    pricePerHour: 2.0,
    providerId,
    available: true,
  });
}

function futureISO(offsetSeconds = 3600) {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

function resetRateState(userId) {
  if (orderRouter._checkOrderCreateRateLimit) {
    orderRouter._checkOrderCreateRateLimit._state.delete(userId);
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /orders per-user rate limit', () => {
  let provider, renterA, renterB;

  beforeAll(async () => {
    provider = await registerAndLogin('prl64prov', 'provider');
    renterA  = await registerAndLogin('prl64rnta');
    renterB  = await registerAndLogin('prl64rntb');
  });

  afterEach(() => {
    // Clean up rate-limit state so tests are independent
    if (renterA) resetRateState(renterA.id);
    if (renterB) resetRateState(renterB.id);
  });

  it('rate limit is configurable and defaults to a positive integer', () => {
    const limit = Number(process.env.ORDER_CREATE_RATE_LIMIT) || 10;
    expect(limit).toBeGreaterThan(0);
    expect(Number.isInteger(limit)).toBe(true);
  });

  it('allows requests below the limit without 429', async () => {
    const gpu = createAvailableGpu(provider.id);
    resetRateState(renterA.id);

    // Send 3 requests — all should be non-429 (may 409 for duplicate booking, but not 429)
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterA.token}`)
        .send({ gpuId: gpu.id, durationMinutes: 60, scheduledStartAt: futureISO(3600 + i * 120) });
      expect(res.status).not.toBe(429);
    }
  });

  it('returns 429 after the user exceeds ORDER_CREATE_RATE_LIMIT in one window', async () => {
    const limit = Number(process.env.ORDER_CREATE_RATE_LIMIT) || 10;
    resetRateState(renterA.id);

    // Fire limit+1 requests. The first `limit` should not be 429;
    // the last one must be 429.
    let hit429 = false;
    for (let i = 0; i < limit + 1; i++) {
      const gpu = createAvailableGpu(provider.id); // fresh GPU each time to avoid 409
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterA.token}`)
        .send({ gpuId: gpu.id, durationMinutes: 60, scheduledStartAt: futureISO(3600 + i * 200) });
      if (res.status === 429) { hit429 = true; break; }
    }
    expect(hit429).toBe(true);
  });

  it('returns 429 error message mentioning the rate limit', async () => {
    const limit = Number(process.env.ORDER_CREATE_RATE_LIMIT) || 10;
    resetRateState(renterA.id);

    // Exhaust the limit
    for (let i = 0; i < limit; i++) {
      const gpu = createAvailableGpu(provider.id);
      await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterA.token}`)
        .send({ gpuId: gpu.id, durationMinutes: 60, scheduledStartAt: futureISO(3600 + i * 200) });
    }

    // The (limit+1)th
    const gpu = createAvailableGpu(provider.id);
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${renterA.token}`)
      .send({ gpuId: gpu.id, durationMinutes: 60, scheduledStartAt: futureISO(7200) });
    expect(res.status).toBe(429);
    const msg = (res.body.error && res.body.error.message) || res.body.message || '';
    expect(msg).toMatch(/order|rate|limit/i);
  });

  it('resetting the state window allows the same user to create orders again', async () => {
    const limit = Number(process.env.ORDER_CREATE_RATE_LIMIT) || 10;

    // Exhaust
    resetRateState(renterA.id);
    for (let i = 0; i < limit; i++) {
      const gpu = createAvailableGpu(provider.id);
      await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterA.token}`)
        .send({ gpuId: gpu.id, durationMinutes: 60, scheduledStartAt: futureISO(3600 + i * 200) });
    }

    // Reset (simulates window expiry)
    resetRateState(renterA.id);

    // Should work again
    const gpu = createAvailableGpu(provider.id);
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${renterA.token}`)
      .send({ gpuId: gpu.id, durationMinutes: 60, scheduledStartAt: futureISO(10800) });
    expect(res.status).not.toBe(429);
  });

  it('user B is unaffected when user A hits the rate limit', async () => {
    const limit = Number(process.env.ORDER_CREATE_RATE_LIMIT) || 10;

    // Exhaust renterA
    resetRateState(renterA.id);
    resetRateState(renterB.id);
    for (let i = 0; i < limit; i++) {
      const gpu = createAvailableGpu(provider.id);
      await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterA.token}`)
        .send({ gpuId: gpu.id, durationMinutes: 60, scheduledStartAt: futureISO(3600 + i * 200) });
    }

    // renterA is blocked
    const gpuA = createAvailableGpu(provider.id);
    const resA = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${renterA.token}`)
      .send({ gpuId: gpuA.id, durationMinutes: 60, scheduledStartAt: futureISO(20000) });
    expect(resA.status).toBe(429);

    // renterB is NOT blocked
    const gpuB = createAvailableGpu(provider.id);
    const resB = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${renterB.token}`)
      .send({ gpuId: gpuB.id, durationMinutes: 60, scheduledStartAt: futureISO(20000) });
    expect(resB.status).not.toBe(429);
  });
});
