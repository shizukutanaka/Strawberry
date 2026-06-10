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

    it('prevents self-registration with admin role (privilege escalation)', async () => {
      const res = await request(app)
        .post('/api/v1/users/register')
        .send({
          username: `adm${unique}`.slice(0, 28),
          email: `adm_${unique}@example.com`,
          password: 'Test1234!',
          role: 'admin'
        });
      // 400 (schema rejects 'admin') または 201 でも role が 'user' か 'provider' であること
      if (res.statusCode === 201) {
        expect(['user', 'provider']).toContain(res.body.user.role);
      } else {
        expect(res.statusCode).toBe(400);
      }
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
  // 二重予約防止(409)導入により、注文ごとに新しい GPU をシードする。
  describe('Order create + status transition (regression)', () => {
    const GpuRepository = require('../src/db/json/GpuRepository');
    let token;

    const seedGpu = () => GpuRepository.create({
      name: 'IT Test GPU', vendor: 'NVIDIA', model: 'RTX-IT', memoryGB: 24, pricePerHour: 0.5,
    }).id;

    beforeAll(async () => {
      // ユーザー登録→ログインでトークン取得
      const u = `ord${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: u, email: `${u}@example.com`, password: 'Test1234!' });
      const login = await request(app).post('/api/v1/users/login')
        .send({ email: `${u}@example.com`, password: 'Test1234!' });
      token = login.body.token;
    });

    it('creates an order (201) with the handler contract (gpuId + durationMinutes)', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId: seedGpu(), durationMinutes: 60 });
      expect(res.statusCode).toBe(201);
      expect(res.body.order).toHaveProperty('id');
      expect(res.body.order.status).toBe('pending');
    });

    it('rejects an invalid status transition with 400 (not a 500 ReferenceError)', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId: seedGpu(), durationMinutes: 60 });
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
        .send({ gpuId: seedGpu(), durationMinutes: 60 });
      const orderId = create.body.order.id;
      const res = await request(app)
        .put(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'cancelled' });
      expect(res.statusCode).toBe(200);
      expect(res.body.order.status).toBe('cancelled');
    });

    it('rejects double-booking the same GPU with 409', async () => {
      const gpuId = seedGpu();
      const first = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(first.statusCode).toBe(201);
      const second = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(second.statusCode).toBe(409);
    });
  });

  // 新規実装機能（health / openapi / logout / pagination / earnings / auto-expiry）
  describe('Product gap features', () => {
    const GpuRepository = require('../src/db/json/GpuRepository');
    const seedGpu = () => GpuRepository.create({
      name: 'Gap Test GPU', vendor: 'NVIDIA', model: 'RTX-GAP', memoryGB: 24, pricePerHour: 0.5,
    }).id;

    const loginFull = async (prefix, role) => {
      const u = `${prefix}${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: u, email: `${u}@example.com`, password: 'Test1234!', ...(role ? { role } : {}) });
      const login = await request(app).post('/api/v1/users/login')
        .send({ email: `${u}@example.com`, password: 'Test1234!' });
      return login.body; // { token, refreshToken }
    };
    const registerAndLogin = async (prefix, role) => (await loginFull(prefix, role)).token;

    it('GET /health → 200 with status ok (no auth, no rate limit)', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body).toHaveProperty('uptimeSeconds');
    });

    it('GET /openapi.json → 200 with an OpenAPI 3 document', async () => {
      const res = await request(app).get('/openapi.json');
      expect(res.statusCode).toBe(200);
      expect(res.body.openapi).toMatch(/^3\./);
      expect(res.body).toHaveProperty('paths');
    });

    it('POST /users/logout revokes the token (subsequent /users/me → 401)', async () => {
      const token = await registerAndLogin('lo');
      const before = await request(app).get('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`);
      expect(before.statusCode).toBe(200);
      const logout = await request(app).post('/api/v1/users/logout')
        .set('Authorization', `Bearer ${token}`);
      expect(logout.statusCode).toBe(200);
      const after = await request(app).get('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`);
      expect(after.statusCode).toBe(401);
    });

    it('login returns both an access token and a refresh token', async () => {
      const body = await loginFull('rf1');
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('refreshToken');
      expect(typeof body.refreshToken).toBe('string');
    });

    it('POST /users/refresh issues a new working access token', async () => {
      const { refreshToken } = await loginFull('rf2');
      const refresh = await request(app).post('/api/v1/users/refresh')
        .send({ refreshToken });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.body).toHaveProperty('token');
      // the new access token works against a protected route
      const me = await request(app).get('/api/v1/users/me')
        .set('Authorization', `Bearer ${refresh.body.token}`);
      expect(me.statusCode).toBe(200);
    });

    it('a refresh token cannot be used as an access token (type separation)', async () => {
      const { refreshToken } = await loginFull('rf3');
      const me = await request(app).get('/api/v1/users/me')
        .set('Authorization', `Bearer ${refreshToken}`);
      expect(me.statusCode).toBe(401);
    });

    it('an access token cannot be used to refresh (wrong type → 401)', async () => {
      const { token } = await loginFull('rf4');
      const refresh = await request(app).post('/api/v1/users/refresh')
        .send({ refreshToken: token });
      expect(refresh.statusCode).toBe(401);
    });

    it('logout with the refresh token revokes it (subsequent refresh → 401)', async () => {
      const { token, refreshToken } = await loginFull('rf5');
      const logout = await request(app).post('/api/v1/users/logout')
        .set('Authorization', `Bearer ${token}`)
        .send({ refreshToken });
      expect(logout.statusCode).toBe(200);
      const refresh = await request(app).post('/api/v1/users/refresh')
        .send({ refreshToken });
      expect(refresh.statusCode).toBe(401);
    });

    it('POST /users/refresh without a refresh token → 400', async () => {
      const res = await request(app).post('/api/v1/users/refresh').send({});
      expect(res.statusCode).toBe(400);
    });

    it('GET /orders supports limit/offset pagination', async () => {
      const token = await registerAndLogin('pg');
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post('/api/v1/orders')
          .set('Authorization', `Bearer ${token}`)
          .send({ gpuId: seedGpu(), durationMinutes: 30 });
        expect(res.statusCode).toBe(201);
      }
      const page1 = await request(app)
        .get('/api/v1/orders?limit=2&offset=0')
        .set('Authorization', `Bearer ${token}`);
      expect(page1.statusCode).toBe(200);
      expect(page1.body.orders.length).toBe(2);
      expect(page1.body.total).toBeGreaterThanOrEqual(3);
      expect(page1.body.limit).toBe(2);
      const page2 = await request(app)
        .get('/api/v1/orders?limit=2&offset=2')
        .set('Authorization', `Bearer ${token}`);
      expect(page2.statusCode).toBe(200);
      expect(page2.body.orders.length).toBeGreaterThanOrEqual(1);
      expect(page2.body.offset).toBe(2);
    });

    it('GET /orders/provider/earnings → 200 for provider, 403 for user', async () => {
      const providerToken = await registerAndLogin('pe', 'provider');
      const userToken = await registerAndLogin('ue');
      const ok = await request(app)
        .get('/api/v1/orders/provider/earnings')
        .set('Authorization', `Bearer ${providerToken}`);
      expect(ok.statusCode).toBe(200);
      expect(ok.body.earnings).toHaveProperty('completedSats');
      const denied = await request(app)
        .get('/api/v1/orders/provider/earnings')
        .set('Authorization', `Bearer ${userToken}`);
      expect(denied.statusCode).toBe(403);
    });

    it('GET /admin/stats → 200 for admin with marketplace aggregates, 403 for user', async () => {
      const UserRepository = require('../src/db/json/UserRepository');
      // admin はレポ直更新で昇格（自己登録では admin を取得できない仕様のため）
      const u = `st${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: u, email: `${u}@example.com`, password: 'Test1234!' });
      const created = UserRepository.getByEmail(`${u}@example.com`);
      UserRepository.update(created.id, { role: 'admin' });
      const login = await request(app).post('/api/v1/users/login')
        .send({ email: `${u}@example.com`, password: 'Test1234!' });
      const adminToken = login.body.token;

      const ok = await request(app)
        .get('/api/v1/admin/stats')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(ok.statusCode).toBe(200);
      expect(ok.body.users.total).toBeGreaterThanOrEqual(1);
      expect(ok.body.orders).toHaveProperty('byStatus');
      expect(ok.body.gmv).toHaveProperty('completedSats');
      expect(ok.body.gpus).toHaveProperty('available');

      const userToken = await registerAndLogin('ns');
      const denied = await request(app)
        .get('/api/v1/admin/stats')
        .set('Authorization', `Bearer ${userToken}`);
      expect(denied.statusCode).toBe(403);
    });

    it('auto-expires stale pending orders (payment timeout)', async () => {
      const token = await registerAndLogin('ex');
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId: seedGpu(), durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;
      // タイムアウト 0 分 → 即時失効。env は呼出し毎に解決される。
      const prevTimeout = process.env.ORDER_PENDING_TIMEOUT_MINUTES;
      process.env.ORDER_PENDING_TIMEOUT_MINUTES = '0';
      try {
        await new Promise(r => setTimeout(r, 10));
        // スイープは一覧取得・注文作成時に走る（遅延スイープ）ため、一覧を叩いて発火させる
        await request(app).get('/api/v1/orders?status=pending&limit=1')
          .set('Authorization', `Bearer ${token}`);
        const after = await request(app)
          .get(`/api/v1/orders/${orderId}`)
          .set('Authorization', `Bearer ${token}`);
        expect(after.body.order ? after.body.order.status : after.body.status).toBe('cancelled');
      } finally {
        if (prevTimeout === undefined) delete process.env.ORDER_PENDING_TIMEOUT_MINUTES;
        else process.env.ORDER_PENDING_TIMEOUT_MINUTES = prevTimeout;
      }
    });
  });
});
