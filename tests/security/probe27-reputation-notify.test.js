// tests/security/probe27-reputation-notify.test.js
// Probe 27 regression tests:
// 1. (removed 2026-09 — POST /marketplace/rank no longer exists)
// 3. GET /notification-settings/:userId: lineToken is masked as '***' not returned in plaintext

const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');

const uniq = `p27${Date.now().toString(36)}`;
let adminTok, userTok, userId;

beforeAll(async () => {
  const admName = `p27adm${uniq}`.slice(0, 20);
  const admEmail = `${admName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: admName, email: admEmail, password: 'Test1234!' });
  const admUser = UserRepository.getByEmail(admEmail);
  UserRepository.update(admUser.id, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: admEmail, password: 'Test1234!' })).body.token;

  const usrName = `p27usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  const usr = UserRepository.getByEmail(usrEmail);
  userId = usr.id;
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;
});

// ─── 1. /rank: opts stripped ─────────────────────────────────────────────────
// POST /marketplace/auction の検査は、エンドポイント自体を削除したため除去した。
// この製品には入札という概念が無く（入札を保存する場所も、貸し手が要件を見る画面も
// 無い）、旧エンドポイントは入札内容を呼び出し側が捏造できた。効用スコアの計算は
// GET /gpus?sort=recommended に移り、実データで検証している
// （tests/api/gpu-recommended-sort.test.js）。

// ─── 3. GET /notification-settings: lineToken masked ─────────────────────────
describe('GET /notification-settings/:userId: lineToken is masked', () => {
  const TOKEN = 'A'.repeat(40); // valid 40-char token

  beforeAll(async () => {
    // Store a token
    await request(app)
      .post(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${userTok}`)
      .send({ lineToken: TOKEN });
  });

  it('GET returns lineToken as "***" not the actual token', async () => {
    const res = await request(app)
      .get(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${userTok}`);
    expect(res.statusCode).toBe(200);
    // Token must be masked
    expect(res.body.lineToken).toBe('***');
    // Must NOT return the actual token
    expect(res.body.lineToken).not.toBe(TOKEN);
  });

  it('GET by admin also returns masked token', async () => {
    const res = await request(app)
      .get(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.lineToken).toBe('***');
  });

  it('GET returns empty object (not leaked token) when no settings exist', async () => {
    // Create a user with no settings
    const noSettingsName = `p27ns${uniq}`.slice(0, 20);
    const noSettingsEmail = `${noSettingsName}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username: noSettingsName, email: noSettingsEmail, password: 'Test1234!' });
    const noSettingsUser = UserRepository.getByEmail(noSettingsEmail);
    const nsTok = (await request(app).post('/api/v1/users/login')
      .send({ email: noSettingsEmail, password: 'Test1234!' })).body.token;

    const res = await request(app)
      .get(`/api/v1/notification-settings/${noSettingsUser.id}`)
      .set('Authorization', `Bearer ${nsTok}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({});
  });

  it('notification-settings.js source: GET response masks lineToken', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/notification-settings.js'), 'utf-8'
    );
    // Must mask the token before returning
    expect(src).toMatch(/lineToken.*\*\*\*/);
    // Must NOT return settings[userId] directly without masking
    expect(src).not.toMatch(/res\.json\(settings\[userId\]/);
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
