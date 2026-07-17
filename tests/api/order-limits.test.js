// Order time-ceiling validation: a single order must not be able to monopolize a
// GPU's calendar via an unbounded duration, nor reserve a slot beyond the system's
// 90-day pending retention via an unbounded future schedule.
const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');

describe('Order time ceilings (duration + schedule horizon)', () => {
  let token, gpuId;

  beforeAll(async () => {
    const u = `olim${Date.now().toString(36)}`.slice(0, 20);
    await request(app).post('/api/v1/users/register')
      .send({ username: u, email: `${u}@example.com`, password: 'Test1234!' });
    token = (await request(app).post('/api/v1/users/login')
      .send({ email: `${u}@example.com`, password: 'Test1234!' })).body.token;
  });

  beforeEach(() => {
    gpuId = GpuRepository.create({
      name: 'Limit GPU', vendor: 'NVIDIA', model: 'RTX-LIM', memoryGB: 16, pricePerHour: 100,
    }).id;
  });

  it('rejects an absurd duration that would monopolize the GPU calendar (400, capped by schema)', async () => {
    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ gpuId, durationMinutes: 525600000 }); // ~1000 years
    expect(res.statusCode).toBe(400);
  });

  it('accepts a duration at the 30-day cap (201)', async () => {
    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ gpuId, durationMinutes: 30 * 24 * 60 }); // exactly 30 days
    expect(res.statusCode).toBe(201);
  });

  it('rejects a schedule far beyond the 90-day retention horizon (400)', async () => {
    const farFuture = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ gpuId, durationMinutes: 60, scheduledStartAt: farFuture });
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message || res.body.error || res.body.message).toMatch(/more than 90 days in the future/i);
  });

  it('rejects a non-date scheduledStartAt (400) rather than silently treating it as NaN', async () => {
    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ gpuId, durationMinutes: 60, scheduledStartAt: 'not-a-date' });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a near-future schedule within the horizon (201)', async () => {
    const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ gpuId, durationMinutes: 60, scheduledStartAt: soon });
    expect(res.statusCode).toBe(201);
  });
});
