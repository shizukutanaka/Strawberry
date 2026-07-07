// tests/security/probe65-gpu-eligibility.test.js
// Tests for GET /gpus/:id/eligibility — a pre-flight endpoint that tells a
// renter whether they meet the GPU's booking requirements BEFORE creating an
// order, preventing unexpected 422s.
//
// Scenarios covered:
//   1. Authenticated renter, no restrictions → eligible: true
//   2. Unauthenticated → 401
//   3. Provider trying to rent their own GPU → eligible: false, reason: self_trade
//   4. GPU with rejectUnratedRenters:true, renter has no history → eligible: false
//   5. GPU with minRenterRating:4.0, renter is below floor → eligible: false
//   6. GPU with available:false → eligible: false, reason: not_available
//   7. Response always includes requirements and renterRating metadata

const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');

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

function makeGpu(providerId, overrides = {}) {
  return GpuRepository.create({
    name: `ELG-${Date.now()}-${Math.random()}`,
    model: 'A100',
    vendor: 'NVIDIA',
    memoryGB: 80,
    pricePerHour: 2.0,
    providerId,
    available: true,
    ...overrides,
  });
}

// Directly seed a completed order with a renterReview to give the user a rating
function seedRenterReview(userId, providerId, rating) {
  return OrderRepository.create({
    userId,
    providerId,
    gpuId: 'fake-gpu-id',
    status: 'completed',
    durationMinutes: 60,
    pricePerHour: 2.0,
    totalPrice: 100,
    scheduledStartAt: new Date(Date.now() - 7200 * 1000).toISOString(),
    renterReview: { rating, comment: 'test', reviewerId: providerId, reviewedAt: new Date().toISOString() },
  });
}

// ── describe blocks ───────────────────────────────────────────────────────────

describe('GET /gpus/:id/eligibility: basic auth and format', () => {
  let provider, renter;
  beforeAll(async () => {
    provider = await registerAndLogin('elgprov65a', 'provider');
    renter   = await registerAndLogin('elgrent65a');
  });

  it('returns 401 for unauthenticated requests', async () => {
    const gpu = makeGpu(provider.id);
    const res = await request(app).get(`/api/v1/gpus/${gpu.id}/eligibility`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown GPU id', async () => {
    const res = await request(app)
      .get('/api/v1/gpus/00000000-0000-0000-0000-000000000000/eligibility')
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.status).toBe(404);
  });

  it('returns eligible:true for an unrestricted available GPU', async () => {
    const gpu = makeGpu(provider.id);
    const res = await request(app)
      .get(`/api/v1/gpus/${gpu.id}/eligibility`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
    expect(res.body.reason).toBeNull();
    expect(res.body.requirements).toBeDefined();
    expect(res.body.renterRating).toBeDefined();
  });

  it('response always includes requirements and renterRating', async () => {
    const gpu = makeGpu(provider.id, { minRenterRating: 4.0, rejectUnratedRenters: true });
    const res = await request(app)
      .get(`/api/v1/gpus/${gpu.id}/eligibility`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.requirements.minRenterRating).toBe('number');
    expect(res.body.requirements.rejectUnratedRenters).toBe(true);
    expect(typeof res.body.renterRating.count).toBe('number');
    expect(typeof res.body.renterRating.hasHistory).toBe('boolean');
  });
});

describe('GET /gpus/:id/eligibility: self-trade prevention', () => {
  it('returns eligible:false with reason self_trade for the GPU owner', async () => {
    const provider = await registerAndLogin('elgprov65b', 'provider');
    const gpu = makeGpu(provider.id);
    const res = await request(app)
      .get(`/api/v1/gpus/${gpu.id}/eligibility`)
      .set('Authorization', `Bearer ${provider.token}`);
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
    expect(res.body.reason).toBe('self_trade');
  });
});

describe('GET /gpus/:id/eligibility: rejectUnratedRenters', () => {
  let provider, renter;
  beforeAll(async () => {
    provider = await registerAndLogin('elgprov65c', 'provider');
    renter   = await registerAndLogin('elgrent65c');
  });

  it('returns eligible:false with reason no_rating_history when renter has no reviews', async () => {
    const gpu = makeGpu(provider.id, { rejectUnratedRenters: true });
    const res = await request(app)
      .get(`/api/v1/gpus/${gpu.id}/eligibility`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
    expect(res.body.reason).toBe('no_rating_history');
    expect(res.body.renterRating.hasHistory).toBe(false);
    expect(res.body.message).toMatch(/rating history/i);
  });

  it('eligible:true when rejectUnratedRenters:false and renter is unrated', async () => {
    const gpu = makeGpu(provider.id, { rejectUnratedRenters: false });
    const res = await request(app)
      .get(`/api/v1/gpus/${gpu.id}/eligibility`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
  });
});

describe('GET /gpus/:id/eligibility: minRenterRating floor', () => {
  it('returns eligible:false with reason below_rating_floor when renter is below floor', async () => {
    const provider = await registerAndLogin('elgprov65d', 'provider');
    const renter   = await registerAndLogin('elgrent65d');
    // Seed a low rating for the renter
    seedRenterReview(renter.id, provider.id, 2);

    const gpu = makeGpu(provider.id, { minRenterRating: 4.0 });
    const res = await request(app)
      .get(`/api/v1/gpus/${gpu.id}/eligibility`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
    expect(res.body.reason).toBe('below_rating_floor');
    expect(res.body.renterRating.average).toBeLessThan(4.0);
    expect(res.body.message).toMatch(/rating/i);
  });

  it('eligible:true when renter meets the floor', async () => {
    const provider = await registerAndLogin('elgprov65e', 'provider');
    const renter   = await registerAndLogin('elgrent65e');
    seedRenterReview(renter.id, provider.id, 5);

    const gpu = makeGpu(provider.id, { minRenterRating: 4.0 });
    const res = await request(app)
      .get(`/api/v1/gpus/${gpu.id}/eligibility`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
  });
});

describe('GET /gpus/:id/eligibility: GPU availability', () => {
  it('returns eligible:false with reason not_available when GPU is unavailable', async () => {
    const provider = await registerAndLogin('elgprov65f', 'provider');
    const renter   = await registerAndLogin('elgrent65f');
    const gpu = makeGpu(provider.id, { available: false });

    const res = await request(app)
      .get(`/api/v1/gpus/${gpu.id}/eligibility`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
    expect(res.body.reason).toBe('not_available');
  });
});
