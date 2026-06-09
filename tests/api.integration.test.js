// API統合テスト（Jest + supertest）
// 旧テストは存在しない '../src/app' を require し、旧 '/api/' プレフィクスと無認証前提で
// 書かれていたため suite ごとロードに失敗していた。実アプリ(server.js が {app} を export)に
// 結線し、現行の契約（/api/v1 プレフィクス＋保護リソースは認証必須）を検証する。
const request = require('supertest');
const { app } = require('../src/api/server');

// 一意な英数字のみ（schema は username に alphanum を要求）。
// register クラッシュバグ修正の回帰テストを兼ねる。
const unique = (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).replace(/[^a-z0-9]/gi, '');

describe('API Integration', () => {
  describe('User API', () => {
    it('registers a new user (201) — guards the fixed userId-undefined crash', async () => {
      const res = await request(app)
        .post('/api/v1/users/register')
        .send({
          username: `it${unique}`.slice(0, 28),
          email: `it_${unique}@example.com`,
          password: 'Test1234!'
        });
      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('message');
      expect(res.body).toHaveProperty('user');
      expect(res.body.user).not.toHaveProperty('password');
    });

    it('rejects duplicate email with 409', async () => {
      const email = `dup_${unique}@example.com`;
      const body = { username: `du${unique}`.slice(0, 28), email, password: 'Test1234!' };
      await request(app).post('/api/v1/users/register').send(body);
      const res = await request(app)
        .post('/api/v1/users/register')
        .send({ ...body, username: `dux${unique}`.slice(0, 28) });
      expect(res.statusCode).toBe(409);
    });

    it('rejects invalid registration payload with 400', async () => {
      const res = await request(app)
        .post('/api/v1/users/register')
        .send({ username: 'a', email: 'bad', password: '' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('Protected resources require auth', () => {
    it('GET /api/v1/gpus without a token → 401', async () => {
      const res = await request(app).get('/api/v1/gpus');
      expect(res.statusCode).toBe(401);
    });

    it('POST /api/v1/orders without a token → 401', async () => {
      const res = await request(app).post('/api/v1/orders').send({});
      expect(res.statusCode).toBe(401);
    });

    it('POST /api/v1/payments without a token → 401', async () => {
      const res = await request(app).post('/api/v1/payments').send({});
      expect(res.statusCode).toBe(401);
    });
  });

  describe('Public endpoints', () => {
    it('GET /metrics → 200 (Prometheus, no auth)', async () => {
      const res = await request(app).get('/metrics');
      expect(res.statusCode).toBe(200);
      expect(res.text).toMatch(/# HELP/);
    });
  });
});
