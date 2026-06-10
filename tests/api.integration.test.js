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
    it('GET /api/v1/gpus without a token → 200 (public browse)', async () => {
      const res = await request(app).get('/api/v1/gpus');
      expect(res.statusCode).toBe(200);
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

  // 注文作成→状態遷移の実フロー。スキーマ/ハンドラ不整合で注文作成が常に 400 だったバグと、
  // PUT /:id の status 変更で isValidOrderTransition 未 import の ReferenceError(500) だったバグの回帰。
  describe('Order create + status transition (regression)', () => {
    const GpuRepository = require('../src/db/json/GpuRepository');
    let token;
    let gpuId;

    beforeAll(async () => {
      // ユーザー登録→ログインでトークン取得
      const u = `ord${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: u, email: `${u}@example.com`, password: 'Test1234!' });
      const login = await request(app).post('/api/v1/users/login')
        .send({ email: `${u}@example.com`, password: 'Test1234!' });
      token = login.body.token;
      // 注文対象の GPU をシード（リポジトリ直挿入）
      const gpu = GpuRepository.create({
        name: 'IT Test GPU', vendor: 'NVIDIA', model: 'RTX-IT', memoryGB: 24, pricePerHour: 0.5,
      });
      gpuId = gpu.id;
    });

    it('creates an order (201) with the handler contract (gpuId + durationMinutes)', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId, durationMinutes: 60 });
      expect(res.statusCode).toBe(201);
      expect(res.body.order).toHaveProperty('id');
      expect(res.body.order.status).toBe('pending');
    });

    it('rejects an invalid status transition with 400 (not a 500 ReferenceError)', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId, durationMinutes: 60 });
      const orderId = create.body.order.id;
      // pending -> completed は不正遷移（pending は matched/cancelled のみ許可）
      const res = await request(app)
        .put(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'completed' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/transition/i);
    });

    it('allows a valid status transition pending -> cancelled', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId, durationMinutes: 60 });
      const orderId = create.body.order.id;
      const res = await request(app)
        .put(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'cancelled' });
      expect(res.statusCode).toBe(200);
      expect(res.body.order.status).toBe('cancelled');
    });
  });
});
