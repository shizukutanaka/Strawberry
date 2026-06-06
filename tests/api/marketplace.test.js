// tests/api/marketplace.test.js
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../src/api/server');
const { config } = require('../../src/utils/config');

const token = jwt.sign({ id: 'u1', role: 'admin' }, config.security.jwtSecret);
const auth = (r) => r.set('Authorization', `Bearer ${token}`);
const GPU = { vramGB: 80, memBandwidthGBs: 3350, benchmarkScore: 300, generation: 'hopper' };

describe('marketplace API', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/marketplace/quote').send({ gpu: GPU });
    expect(res.statusCode).toBe(401);
  });

  it('POST /quote returns a feature-based price for a valid GPU', async () => {
    const res = await auth(request(app).post('/api/v1/marketplace/quote')).send({ gpu: GPU, market: { utilization: 0.5 } });
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.pricePerHour).toBe('number');
    expect(res.body.pricePerHour).toBeGreaterThan(0);
    expect(res.body.breakdown).toBeDefined();
  });

  it('POST /quote validates input (400 on missing gpu)', async () => {
    const res = await auth(request(app).post('/api/v1/marketplace/quote')).send({ market: {} });
    expect(res.statusCode).toBe(400);
  });

  it('POST /rank returns a ranked list and validates input', async () => {
    const ok = await auth(request(app).post('/api/v1/marketplace/rank')).send({ providerIds: ['a', 'b'] });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.body.ranked)).toBe(true);

    const bad = await auth(request(app).post('/api/v1/marketplace/rank')).send({ providerIds: 'nope' });
    expect(bad.statusCode).toBe(400);
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
