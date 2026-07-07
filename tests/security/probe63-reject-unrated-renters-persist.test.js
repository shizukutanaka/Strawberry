// tests/security/probe63-reject-unrated-renters-persist.test.js
// Regression for a silent breakage: rejectUnratedRenters was validated by the
// GPU Joi schema and checked in order creation (gpu.rejectUnratedRenters === true),
// but the sanitizeObject allowlist in both POST /gpus and PUT /gpus/:id omitted it.
// The field was silently stripped → always undefined → Sybil-resistance never worked.
//
// This file tests the full round-trip: set the field, read it back, and confirm
// that a new order is rejected when the renter has no rating history.

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

// ── helpers ───────────────────────────────────────────────────────────────

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

// ── rejectUnratedRenters persistence round-trip ───────────────────────────

describe('rejectUnratedRenters: field persists through POST and PUT', () => {
  let provider, providerToken;

  beforeAll(async () => {
    provider = await registerAndLogin('prov63', 'provider');
    providerToken = provider.token;
  });

  it('POST /gpus: rejectUnratedRenters is persisted when set at registration', async () => {
    const res = await request(app)
      .post('/api/v1/gpus')
      .set('Authorization', `Bearer ${providerToken}`)
      .send({
        name: `RUR-Test-${Date.now()}`,
        model: 'A100',
        vendor: 'NVIDIA',
        memoryGB: 80,
        clockMHz: 1000,
        powerWatt: 400,
        pricePerHour: 2.0,
        driverVersion: '525.0',
        os: 'Linux',
        arch: 'x86_64',
        apiType: 'CUDA',
        minRenterRating: 4.0,
        rejectUnratedRenters: true,
      });
    expect(res.status).toBe(201);
    const gpuId = res.body.gpu?.id;
    expect(gpuId).toBeDefined();

    // Read back from repository — the stored record must have the field.
    const stored = GpuRepository.getById(gpuId);
    expect(stored.rejectUnratedRenters).toBe(true);
    expect(stored.minRenterRating).toBe(4.0);
  });

  it('PUT /gpus/:id: rejectUnratedRenters can be set/updated via PUT', async () => {
    // Seed a GPU without the field
    const gpu = GpuRepository.create({
      name: `RUR-PUT-${Date.now()}`,
      model: 'A100',
      vendor: 'NVIDIA',
      memoryGB: 80,
      pricePerHour: 2.0,
      providerId: provider.id,
      available: true,
    });

    const res = await request(app)
      .put(`/api/v1/gpus/${gpu.id}`)
      .set('Authorization', `Bearer ${providerToken}`)
      .send({ rejectUnratedRenters: true });
    expect(res.status).toBe(200);

    const stored = GpuRepository.getById(gpu.id);
    expect(stored.rejectUnratedRenters).toBe(true);
  });

  it('PUT /gpus/:id: rejectUnratedRenters can be cleared (set to false)', async () => {
    const gpu = GpuRepository.create({
      name: `RUR-Clear-${Date.now()}`,
      model: 'A100',
      vendor: 'NVIDIA',
      memoryGB: 80,
      pricePerHour: 2.0,
      providerId: provider.id,
      rejectUnratedRenters: true,
    });

    const res = await request(app)
      .put(`/api/v1/gpus/${gpu.id}`)
      .set('Authorization', `Bearer ${providerToken}`)
      .send({ rejectUnratedRenters: false });
    expect(res.status).toBe(200);

    const stored = GpuRepository.getById(gpu.id);
    expect(stored.rejectUnratedRenters).toBe(false);
  });
});

// ── End-to-end: unrated renter blocked when opt-in is set ─────────────────

describe('rejectUnratedRenters: unrated renter is blocked at order creation', () => {
  it('blocks a renter with no rating history when rejectUnratedRenters is true', async () => {
    const provider = await registerAndLogin('prov63e2e', 'provider');
    const renter = await registerAndLogin('rent63e2e');

    // GPU with rejectUnratedRenters:true (seeded directly so attestation is bypassed)
    const gpu = GpuRepository.create({
      name: `RUR-E2E-${Date.now()}`,
      model: 'A100',
      vendor: 'NVIDIA',
      memoryGB: 80,
      pricePerHour: 2.0,
      providerId: provider.id,
      available: true,
      rejectUnratedRenters: true,
    });

    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({
        gpuId: gpu.id,
        durationMinutes: 60,
        scheduledStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    // Unrated renter must be rejected (422) when rejectUnratedRenters is active
    expect(res.status).toBe(422);
    const errMsg = (res.body.error && res.body.error.message) || res.body.error || res.body.message || '';
    expect(errMsg).toMatch(/rating|unrated/i);
  });

  it('allows an unrated renter when rejectUnratedRenters is false (default)', async () => {
    const provider = await registerAndLogin('prov63dflt', 'provider');
    const renter = await registerAndLogin('rent63dflt');

    const gpu = GpuRepository.create({
      name: `RUR-Dflt-${Date.now()}`,
      model: 'A100',
      vendor: 'NVIDIA',
      memoryGB: 80,
      pricePerHour: 2.0,
      providerId: provider.id,
      available: true,
      rejectUnratedRenters: false, // explicitly off
    });

    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({
        gpuId: gpu.id,
        durationMinutes: 60,
        scheduledStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    // Should not be blocked by rejectUnratedRenters
    expect([200, 201, 202, 409]).toContain(res.status); // any non-422 means not blocked
  });
});
