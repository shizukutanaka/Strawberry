// /api/sandbox/apikey[/verify] の配線・認可・本番抑止契約を固定する。
// ルータは実装済み（admin 限定・本番 404）だが未 mount だったため、配線と同時に固定する。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');

let token;
let adminToken;

beforeAll(async () => {
  const suffix = `${Date.now()}`;
  const password = 'TestPass123!';

  const email = `sbx${suffix}@example.com`;
  await request(app).post('/api/v1/users/register').send({
    username: `sbxuser${suffix}`,
    email,
    password,
  });
  const login = await request(app).post('/api/v1/users/login').send({ email, password });
  token = login.body.token;

  const adminEmail = `sbxadm${suffix}@example.com`;
  await request(app).post('/api/v1/users/register').send({
    username: `sbxadmin${suffix}`,
    email: adminEmail,
    password,
  });
  const u = UserRepository.getByEmail(adminEmail);
  UserRepository.update(u.id, { role: 'admin' });
  const adminLogin = await request(app).post('/api/v1/users/login').send({ email: adminEmail, password });
  adminToken = adminLogin.body.token;
});

describe('POST /api/sandbox/apikey', () => {
  it('requires authentication (401 without token)', async () => {
    const res = await request(app).post('/api/sandbox/apikey').send({ userId: 'u1' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-admin users (403)', async () => {
    const res = await request(app)
      .post('/api/sandbox/apikey')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'u1' });
    expect(res.statusCode).toBe(403);
  });

  it('issues an API key for admin and verifies it', async () => {
    const issue = await request(app)
      .post('/api/sandbox/apikey')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: 'u1' });
    expect(issue.statusCode).toBe(200);
    expect(typeof issue.body.apiKey).toBe('string');
    expect(issue.body.apiKey.length).toBeGreaterThan(0);

    const verify = await request(app)
      .post('/api/sandbox/apikey/verify')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ apiKey: issue.body.apiKey });
    expect(verify.statusCode).toBe(200);
    expect(verify.body).toEqual({ valid: true });
  });

  it('returns valid:false for an unknown key', async () => {
    const res = await request(app)
      .post('/api/sandbox/apikey/verify')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ apiKey: 'nonexistent' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('rejects a missing userId (400)', async () => {
    const res = await request(app)
      .post('/api/sandbox/apikey')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.statusCode).toBe(400);
  });
});

describe('production gate', () => {
  it('returns 404 for all sandbox routes when NODE_ENV=production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(app)
        .post('/api/sandbox/apikey')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: 'u1' });
      expect(res.statusCode).toBe(404);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
