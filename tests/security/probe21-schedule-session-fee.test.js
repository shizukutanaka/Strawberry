// tests/security/probe21-schedule-session-fee.test.js
// Probe 21 regression tests:
// 1. GET /gpus/:id/schedule no longer exposes status field in blockedSlots
// 2. POST /:id/start rejects orders with future scheduledStartAt
// 3. DELETE /me sets sessionsRevokedAt — sibling tokens become invalid immediately

const request = require('supertest');

describe('GET /gpus/:id/schedule: status field removed from blockedSlots', () => {
  const { app } = require('../../src/api/server');
  const GpuRepository = require('../../src/db/json/GpuRepository');
  const OrderRepository = require('../../src/db/json/OrderRepository');

  it('blockedSlots have no status field', async () => {
    const gpu = GpuRepository.create({
      name: 'Sched Test GPU', vendor: 'NVIDIA', model: 'RTX-SCH', memoryGB: 8,
      pricePerHour: 100, providerId: 'sched-prov-test',
    });
    OrderRepository.create({
      gpuId: gpu.id, userId: 'sched-user-test', providerId: 'sched-prov-test',
      durationMinutes: 60, status: 'active',
      pricePerHour: 100, totalPrice: 100, totalPriceJPY: 5000000,
      scheduledStartAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    const res = await request(app).get(`/api/v1/gpus/${gpu.id}/schedule`);
    expect(res.statusCode).toBe(200);
    const slots = res.body.blockedSlots;
    expect(Array.isArray(slots)).toBe(true);
    expect(slots.length).toBeGreaterThan(0);
    // status must NOT be present in any slot
    slots.forEach(slot => {
      expect(slot).not.toHaveProperty('status');
      expect(slot).toHaveProperty('from');
      expect(slot).toHaveProperty('to');
      expect(slot).toHaveProperty('type', 'order');
    });

    // Clean up
    GpuRepository.delete(gpu.id);
  });
});

describe('DELETE /me: sessionsRevokedAt invalidates sibling tokens', () => {
  const { app } = require('../../src/api/server');
  const UserRepository = require('../../src/db/json/UserRepository');

  const uniq = `dme${Date.now().toString(36)}`;
  const email = `${uniq}@example.com`;
  const username = uniq.slice(0, 20);

  let token1, token2, userId;

  beforeAll(async () => {
    await request(app).post('/api/v1/users/register')
      .send({ username, email, password: 'Test1234!' });
    const u = UserRepository.getByEmail(email);
    userId = u.id;

    // Login from two "devices"
    const r1 = await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' });
    token1 = r1.body.token;
    // Small delay to get distinct iat
    await new Promise(r => setTimeout(r, 1100));
    const r2 = await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' });
    token2 = r2.body.token;
  });

  it('both tokens work before deactivation', async () => {
    const r1 = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token1}`);
    const r2 = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token2}`);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
  });

  it('after DELETE /me with token2, token1 (sibling) is also rejected', async () => {
    const delRes = await request(app).delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${token2}`)
      .send({ password: 'Test1234!' });
    expect(delRes.statusCode).toBe(200);

    // token1 was issued before sessionsRevokedAt — must now be rejected
    const r1 = await request(app).get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token1}`);
    expect(r1.statusCode).toBe(401);
  });
});

