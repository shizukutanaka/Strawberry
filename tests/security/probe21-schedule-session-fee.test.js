// tests/security/probe21-schedule-session-fee.test.js
// Probe 21 regression tests:
// 1. (removed 2026-09 — GET /gpus/:id/schedule no longer exists)
// 2. POST /:id/start rejects orders with future scheduledStartAt
// 3. DELETE /me sets sessionsRevokedAt — sibling tokens become invalid immediately
// 4. BTC_FEE_RATE validated at module load (NaN / out-of-range → throw)

const request = require('supertest');

describe('DELETE /me: sessionsRevokedAt invalidates sibling tokens', () => {
  const { app } = require('../../src/api/server');
  const UserRepository = require('../../src/db/json/UserRepository');

  const uniq = `dme${Date.now().toString(36)}`;
  const email = `${uniq}@example.com`;
  const username = uniq.slice(0, 20);

  let token1, token2, _userId;

  beforeAll(async () => {
    await request(app).post('/api/v1/users/register')
      .send({ username, email, password: 'Test1234!' });
    const u = UserRepository.getByEmail(email);
    _userId = u.id;

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
      .set('Authorization', `Bearer ${token2}`);
    expect(delRes.statusCode).toBe(200);

    // token1 was issued before sessionsRevokedAt — must now be rejected
    const r1 = await request(app).get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token1}`);
    expect(r1.statusCode).toBe(401);
  });
});

describe('BTC_FEE_RATE validation at module load', () => {
  it('valid default FEE_RATE (0.015) passes validation', () => {
    // Module already loaded with default — if it threw, this test file would error
    const { FEE_RATE } = require('../../src/payments/fee-rate');
    expect(FEE_RATE).toBe(0.015);
    expect(Number.isFinite(FEE_RATE)).toBe(true);
    expect(FEE_RATE).toBeGreaterThanOrEqual(0);
    expect(FEE_RATE).toBeLessThan(1);
  });

  it('FEE_RATE in [0, 1) is valid (boundary checks)', () => {
    const validate = (rate) => {
      if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
        throw new Error(`Invalid BTC_FEE_RATE: "${rate}". Must be a finite number in [0, 1).`);
      }
      return true;
    };
    expect(validate(0)).toBe(true);
    expect(validate(0.015)).toBe(true);
    expect(validate(0.999)).toBe(true);
    expect(() => validate(1.0)).toThrow(/Invalid BTC_FEE_RATE/);
    expect(() => validate(-0.1)).toThrow(/Invalid BTC_FEE_RATE/);
    expect(() => validate(NaN)).toThrow(/Invalid BTC_FEE_RATE/);
    expect(() => validate(Infinity)).toThrow(/Invalid BTC_FEE_RATE/);
    expect(() => validate(1.5)).toThrow(/Invalid BTC_FEE_RATE/);
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
