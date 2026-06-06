// tests/api/marketplace-escrow.test.js
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../src/api/server');
const { config } = require('../../src/utils/config');

const adminTok = jwt.sign({ id: 'admin1', role: 'admin' }, config.security.jwtSecret);
const userTok = jwt.sign({ id: 'user1', role: 'user' }, config.security.jwtSecret);
const asAdmin = (r) => r.set('Authorization', `Bearer ${adminTok}`);
const GPU = { vramGB: 80, memBandwidthGBs: 3350, benchmarkScore: 300, generation: 'hopper' };

describe('marketplace escrow lifecycle API', () => {
  it('escrow ops require admin role (403 for plain user)', async () => {
    const res = await request(app)
      .post('/api/v1/marketplace/escrow/open')
      .set('Authorization', `Bearer ${userTok}`)
      .send({ orderId: 'o', gpu: GPU });
    expect(res.statusCode).toBe(403);
  });

  it('drives the full happy path: open -> pay -> verify -> SETTLED', async () => {
    const opened = await asAdmin(request(app).post('/api/v1/marketplace/escrow/open'))
      .send({ orderId: `o-${Date.now()}`, providerId: 'prov-h', gpu: GPU, durationMinutes: 60 });
    expect(opened.statusCode).toBe(201);
    expect(opened.body.escrow.state).toBe('PENDING');
    expect(opened.body.amountSats).toBeGreaterThan(0);
    const id = opened.body.escrow.id;

    const paid = await asAdmin(request(app).post(`/api/v1/marketplace/escrow/${id}/pay`)).send({});
    expect(paid.statusCode).toBe(200);
    expect(paid.body.escrow.state).toBe('HELD');

    const verified = await asAdmin(request(app).post(`/api/v1/marketplace/escrow/${id}/verify`))
      .send({ jobId: `job-${Date.now()}`, providerId: 'prov-h', primaryOutput: [1, 2, 3], utilSamples: [80, 90, 85], auditRate: 0 });
    expect(verified.statusCode).toBe(200);
    expect(verified.body.event).toBe('DELIVER_OK');
    expect(verified.body.escrow.state).toBe('SETTLED');
    expect(verified.body.actions).toContain('reveal_preimage');

    const got = await asAdmin(request(app).get(`/api/v1/marketplace/escrow/${id}`));
    expect(got.statusCode).toBe(200);
    expect(got.body.state).toBe('SETTLED');
  });

  it('validates inputs', async () => {
    const noOrder = await asAdmin(request(app).post('/api/v1/marketplace/escrow/open')).send({ gpu: GPU });
    expect(noOrder.statusCode).toBe(400);

    const opened = await asAdmin(request(app).post('/api/v1/marketplace/escrow/open'))
      .send({ orderId: `o2-${Date.now()}`, gpu: GPU, durationMinutes: 30 });
    const id = opened.body.escrow.id;

    const noJob = await asAdmin(request(app).post(`/api/v1/marketplace/escrow/${id}/verify`)).send({ primaryOutput: [1] });
    expect(noJob.statusCode).toBe(400);

    const badResolve = await asAdmin(request(app).post(`/api/v1/marketplace/escrow/${id}/resolve`)).send({ decision: 'nope' });
    expect(badResolve.statusCode).toBe(400);
  });

  it('returns 404 for unknown escrow', async () => {
    const res = await asAdmin(request(app).get('/api/v1/marketplace/escrow/does-not-exist'));
    expect(res.statusCode).toBe(404);
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
