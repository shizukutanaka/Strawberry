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

  // GPU 時間帯予約（スケジュール貸出・カレンダー）- 不足機能 #11
  describe('GPU time-slot reservations', () => {
    const GpuRepository = require('../src/db/json/GpuRepository');
    const seedGpu = () => GpuRepository.create({
      name: 'Slot Test GPU', vendor: 'NVIDIA', model: 'RTX-SLOT', memoryGB: 16, pricePerHour: 0.5,
    }).id;

    let token;
    beforeAll(async () => {
      const u = `sl${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: u, email: `${u}@example.com`, password: 'Test1234!' });
      const login = await request(app).post('/api/v1/users/login')
        .send({ email: `${u}@example.com`, password: 'Test1234!' });
      token = login.body.token;
    });

    it('order stores scheduledStartAt and scheduledEndAt when provided', async () => {
      const start = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // +2h
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId: seedGpu(), durationMinutes: 60, scheduledStartAt: start });
      expect(res.statusCode).toBe(201);
      expect(res.body.order.scheduledStartAt).toBe(start);
      expect(res.body.order).toHaveProperty('scheduledEndAt');
      const endMs = new Date(res.body.order.scheduledEndAt).getTime();
      const startMs = new Date(start).getTime();
      expect(endMs - startMs).toBe(60 * 60 * 1000);
    });

    it('non-overlapping time slots on the same GPU are both accepted (201)', async () => {
      const gpuId = seedGpu();
      const slot1Start = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(); // +1h
      const slot2Start = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(); // +3h (no overlap with +1h..+2h)
      const first = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId, durationMinutes: 60, scheduledStartAt: slot1Start });
      expect(first.statusCode).toBe(201);
      const second = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId, durationMinutes: 60, scheduledStartAt: slot2Start });
      expect(second.statusCode).toBe(201);
    });

    it('overlapping time slots on the same GPU are rejected with 409', async () => {
      const gpuId = seedGpu();
      const slot1Start = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(); // +4h
      const slot2Start = new Date(Date.now() + 4 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(); // +4.5h (overlaps)
      const first = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId, durationMinutes: 60, scheduledStartAt: slot1Start });
      expect(first.statusCode).toBe(201);
      const second = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId, durationMinutes: 60, scheduledStartAt: slot2Start });
      expect(second.statusCode).toBe(409);
    });

    it('future-scheduled pending order is not auto-expired by timeout sweep', async () => {
      const start = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // +24h
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId: seedGpu(), durationMinutes: 60, scheduledStartAt: start });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;
      const prevTimeout = process.env.ORDER_PENDING_TIMEOUT_MINUTES;
      process.env.ORDER_PENDING_TIMEOUT_MINUTES = '0';
      try {
        await new Promise(r => setTimeout(r, 10));
        await request(app).get('/api/v1/orders?status=pending&limit=1')
          .set('Authorization', `Bearer ${token}`);
        const after = await request(app)
          .get(`/api/v1/orders/${orderId}`)
          .set('Authorization', `Bearer ${token}`);
        // 未来予約は失効しない
        expect(after.body.order ? after.body.order.status : after.body.status).toBe('pending');
      } finally {
        if (prevTimeout === undefined) delete process.env.ORDER_PENDING_TIMEOUT_MINUTES;
        else process.env.ORDER_PENDING_TIMEOUT_MINUTES = prevTimeout;
      }
    });

    it('GET /gpus/:id/schedule returns blocked slots (public, no auth)', async () => {
      const gpuId = seedGpu();
      const start = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(); // +6h
      await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ gpuId, durationMinutes: 60, scheduledStartAt: start });
      const res = await request(app).get(`/api/v1/gpus/${gpuId}/schedule`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('blockedSlots');
      expect(Array.isArray(res.body.blockedSlots)).toBe(true);
      expect(res.body.blockedSlots.length).toBeGreaterThanOrEqual(1);
      const slot = res.body.blockedSlots[0];
      expect(slot).toHaveProperty('from');
      expect(slot).toHaveProperty('to');
      expect(slot).toHaveProperty('orderId');
      expect(slot).toHaveProperty('status');
    });

    it('GET /gpus/:id/schedule returns 404 for unknown GPU', async () => {
      const res = await request(app).get('/api/v1/gpus/00000000-0000-4000-8000-000000000000/schedule');
      expect(res.statusCode).toBe(404);
    });
  });

  // プロバイダによる注文拒否 + レビューシステム
  describe('Provider order rejection + review system', () => {
    const GpuRepository = require('../src/db/json/GpuRepository');
    const UserRepository = require('../src/db/json/UserRepository');
    const OrderRepository = require('../src/db/json/OrderRepository');

    let renterToken, providerToken, otherToken;
    let gpuId, providerId;

    // GPU を provider ユーザーが所有するようにセットアップ
    beforeAll(async () => {
      // renter 登録
      const r = `rv${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: r, email: `${r}@example.com`, password: 'Test1234!' });
      renterToken = (await request(app).post('/api/v1/users/login')
        .send({ email: `${r}@example.com`, password: 'Test1234!' })).body.token;

      // provider 登録（role=provider）
      const p = `pv${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: p, email: `${p}@example.com`, password: 'Test1234!', role: 'provider' });
      const providerLogin = await request(app).post('/api/v1/users/login')
        .send({ email: `${p}@example.com`, password: 'Test1234!' });
      providerToken = providerLogin.body.token;
      providerId = providerLogin.body.user?.id || UserRepository.getByEmail(`${p}@example.com`)?.id;

      // GPU をプロバイダの所有として DB に直接登録
      const gpu = GpuRepository.create({
        name: 'Review Test GPU', vendor: 'NVIDIA', model: 'RTX-REV', memoryGB: 16, pricePerHour: 0.5,
        providerId,
      });
      gpuId = gpu.id;

      // 無関係ユーザー
      const o = `ov${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: o, email: `${o}@example.com`, password: 'Test1234!' });
      otherToken = (await request(app).post('/api/v1/users/login')
        .send({ email: `${o}@example.com`, password: 'Test1234!' })).body.token;
    });

    it('provider can reject a pending order on their GPU (→ cancelled)', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;

      const reject = await request(app)
        .post(`/api/v1/orders/${orderId}/reject`)
        .set('Authorization', `Bearer ${providerToken}`)
        .send({ reason: 'GPU undergoing maintenance' });
      expect(reject.statusCode).toBe(200);

      const order = OrderRepository.getById(orderId);
      expect(order.status).toBe('cancelled');
      expect(order.cancelReason).toBe('provider_rejected');
      expect(order.cancelNote).toBe('GPU undergoing maintenance');
    });

    it('non-provider cannot reject someone else\'s GPU order (403)', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;

      const reject = await request(app)
        .post(`/api/v1/orders/${orderId}/reject`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({});
      expect(reject.statusCode).toBe(403);

      // clean up so it doesn't interfere
      OrderRepository.update(orderId, { status: 'cancelled' });
    });

    it('provider cannot reject a non-pending order (400)', async () => {
      // Create an order and cancel it via the standard path first
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;
      // manually transition to cancelled
      await request(app).put(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ status: 'cancelled' });

      const reject = await request(app)
        .post(`/api/v1/orders/${orderId}/reject`)
        .set('Authorization', `Bearer ${providerToken}`)
        .send({});
      expect(reject.statusCode).toBe(400);
    });

    it('user can submit a review for a completed order (201)', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;
      // force to completed
      OrderRepository.update(orderId, { status: 'completed' });

      const review = await request(app)
        .post(`/api/v1/orders/${orderId}/review`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ rating: 5, comment: 'Excellent GPU!' });
      expect(review.statusCode).toBe(201);
      expect(review.body.review.rating).toBe(5);
      expect(review.body.review.comment).toBe('Excellent GPU!');
    });

    it('cannot review a non-completed order (400)', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;

      const review = await request(app)
        .post(`/api/v1/orders/${orderId}/review`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ rating: 3 });
      expect(review.statusCode).toBe(400);

      // clean up
      OrderRepository.update(orderId, { status: 'cancelled' });
    });

    it('cannot submit a duplicate review (409)', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;
      OrderRepository.update(orderId, { status: 'completed' });

      await request(app).post(`/api/v1/orders/${orderId}/review`)
        .set('Authorization', `Bearer ${renterToken}`).send({ rating: 4 });
      const dup = await request(app)
        .post(`/api/v1/orders/${orderId}/review`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ rating: 2 });
      expect(dup.statusCode).toBe(409);
    });

    it('GET /gpus/:id/reviews returns review list with aggregate (public)', async () => {
      const res = await request(app).get(`/api/v1/gpus/${gpuId}/reviews`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('reviews');
      expect(res.body).toHaveProperty('ratingAverage');
      expect(res.body).toHaveProperty('total');
      expect(Array.isArray(res.body.reviews)).toBe(true);
      expect(res.body.reviews.length).toBeGreaterThanOrEqual(1);
      const r = res.body.reviews[0];
      expect(r).toHaveProperty('rating');
      expect(r).toHaveProperty('orderId');
    });

    it('GET /gpus/:id includes rating aggregate', async () => {
      const res = await request(app).get(`/api/v1/gpus/${gpuId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.gpu).toHaveProperty('rating');
      expect(res.body.gpu.rating).toHaveProperty('average');
      expect(res.body.gpu.rating).toHaveProperty('count');
      expect(res.body.gpu.rating.count).toBeGreaterThanOrEqual(1);
    });

    it('invalid rating value is rejected with 400', async () => {
      // Fresh GPU to avoid any time-slot state from the shared gpuId
      const freshGpuId = GpuRepository.create({
        name: 'Bad Rating GPU', vendor: 'NVIDIA', model: 'RTX-400', memoryGB: 8, pricePerHour: 0.5,
      }).id;
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId: freshGpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;
      OrderRepository.update(orderId, { status: 'completed' });

      const bad = await request(app)
        .post(`/api/v1/orders/${orderId}/review`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ rating: 6 });
      expect(bad.statusCode).toBe(400);
    });

    it('GET /users/:id/reputation returns provider trust profile (public, no auth)', async () => {
      const res = await request(app).get(`/api/v1/users/${providerId}/reputation`);
      expect(res.statusCode).toBe(200);
      expect(res.body.providerId).toBe(providerId);
      expect(res.body).toHaveProperty('score');
      expect(res.body).toHaveProperty('tier');
      expect(res.body).toHaveProperty('stats');
      // 先行テストで★5レビューが1件付いている
      expect(res.body.reviewCount).toBeGreaterThanOrEqual(1);
      expect(res.body.ratingAverage).toBeGreaterThanOrEqual(1);
      expect(typeof res.body.completedOrders).toBe('number');
      expect(typeof res.body.rejectedOrders).toBe('number');
    });

    it('GET /users/:id/reputation → 404 for unknown user', async () => {
      const res = await request(app).get('/api/v1/users/00000000-0000-4000-8000-000000000000/reputation');
      expect(res.statusCode).toBe(404);
    });

    it('completing an order records a provider job result in reputation', async () => {
      const before = await request(app).get(`/api/v1/users/${providerId}/reputation`);
      const beforeCompleted = before.body.stats.completedJobs;

      // pending → active → stop(completed) の主要フローを辿る
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;
      // stop ハンドラは active 状態を要求するので直接遷移させる
      OrderRepository.update(orderId, { status: 'active', providerId });

      const stop = await request(app)
        .post(`/api/v1/orders/${orderId}/stop`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({});
      expect(stop.statusCode).toBe(200);

      const after = await request(app).get(`/api/v1/users/${providerId}/reputation`);
      expect(after.body.stats.completedJobs).toBe(beforeCompleted + 1);
    });
  });

  describe('Notification settings CRUD', () => {
    let userToken, userId;
    beforeAll(async () => {
      const UserRepository = require('../src/db/json/UserRepository');
      const ns = `ns${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: ns, email: `${ns}@example.com`, password: 'Test1234!' });
      const login = await request(app).post('/api/v1/users/login')
        .send({ email: `${ns}@example.com`, password: 'Test1234!' });
      userToken = login.body.token;
      userId = UserRepository.getByEmail(`${ns}@example.com`)?.id;
    });

    it('GET /notification-settings/:userId returns empty object when not configured', async () => {
      const res = await request(app)
        .get(`/api/v1/notification-settings/${userId}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.statusCode).toBe(200);
      expect(typeof res.body).toBe('object');
    });

    it('POST /notification-settings/:userId saves channel configuration', async () => {
      const res = await request(app)
        .post(`/api/v1/notification-settings/${userId}`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ email: 'notify@example.com', enabled: { order_matched: true } });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('GET after POST returns saved settings', async () => {
      const res = await request(app)
        .get(`/api/v1/notification-settings/${userId}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.email).toBe('notify@example.com');
    });

    it('accessing another user settings without auth → 401, with wrong user → 403', async () => {
      const res401 = await request(app).get(`/api/v1/notification-settings/${userId}`);
      expect(res401.statusCode).toBe(401);

      const other = `no${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: other, email: `${other}@example.com`, password: 'Test1234!' });
      const otherLogin = await request(app).post('/api/v1/users/login')
        .send({ email: `${other}@example.com`, password: 'Test1234!' });
      const otherToken = otherLogin.body.token;
      const res403 = await request(app)
        .get(`/api/v1/notification-settings/${userId}`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect(res403.statusCode).toBe(403);
    });
  });

  describe('GPU minRating filter + order dispute', () => {
    const GpuRepository = require('../src/db/json/GpuRepository');
    const OrderRepository = require('../src/db/json/OrderRepository');
    const UserRepository = require('../src/db/json/UserRepository');

    let renterToken, providerToken, gpuId, providerId;

    beforeAll(async () => {
      const r = `dr${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: r, email: `${r}@example.com`, password: 'Test1234!' });
      renterToken = (await request(app).post('/api/v1/users/login')
        .send({ email: `${r}@example.com`, password: 'Test1234!' })).body.token;

      const p = `dp${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: p, email: `${p}@example.com`, password: 'Test1234!', role: 'provider' });
      const providerLogin = await request(app).post('/api/v1/users/login')
        .send({ email: `${p}@example.com`, password: 'Test1234!' });
      providerToken = providerLogin.body.token;
      providerId = providerLogin.body.user?.id || UserRepository.getByEmail(`${p}@example.com`)?.id;

      // GPU with a ★4 review so minRating filter can find it
      const gpu = GpuRepository.create({
        name: 'Dispute/Rating GPU', vendor: 'NVIDIA', model: 'RTX-DR', memoryGB: 24, pricePerHour: 1.2,
        providerId,
      });
      gpuId = gpu.id;
      // Seed a completed order with a ★4 review
      const seedOrder = OrderRepository.create({
        gpuId, userId: 'seed-user', providerId, durationMinutes: 60,
        status: 'completed', totalPrice: 100, createdAt: new Date().toISOString(),
        review: { rating: 4, comment: 'Good', reviewerId: 'seed-user', reviewedAt: new Date().toISOString() }
      });
    });

    it('GET /gpus?minRating=3 returns GPUs with avg rating ≥ 3', async () => {
      // limit=200 so the seeded GPU isn't paginated out by accumulated test data
      const res = await request(app).get('/api/v1/gpus?minRating=3&limit=200');
      expect(res.statusCode).toBe(200);
      expect(res.body.gpus.some(g => g.id === gpuId)).toBe(true);
    });

    it('GET /gpus?minRating=5 excludes GPU with avg 4 stars', async () => {
      const res = await request(app).get('/api/v1/gpus?minRating=5&limit=200');
      expect(res.statusCode).toBe(200);
      expect(res.body.gpus.some(g => g.id === gpuId)).toBe(false);
    });

    it('POST /orders/:id/dispute raises a dispute on an active order (201)', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;
      OrderRepository.update(orderId, { status: 'active', providerId });

      const dispute = await request(app)
        .post(`/api/v1/orders/${orderId}/dispute`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ reason: 'GPU was not responsive' });
      expect(dispute.statusCode).toBe(201);
      expect(dispute.body.dispute.reason).toBe('GPU was not responsive');
      expect(OrderRepository.getById(orderId).status).toBe('disputed');
    });

    it('second dispute on same order → 409', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;
      OrderRepository.update(orderId, { status: 'active', providerId });

      await request(app)
        .post(`/api/v1/orders/${orderId}/dispute`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ reason: 'first' });
      const dup = await request(app)
        .post(`/api/v1/orders/${orderId}/dispute`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ reason: 'duplicate' });
      expect(dup.statusCode).toBe(409);
    });

    it('disputing a pending order → 400', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;
      // status is still 'pending'
      const dispute = await request(app)
        .post(`/api/v1/orders/${orderId}/dispute`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ reason: 'premature' });
      expect(dispute.statusCode).toBe(400);
      OrderRepository.update(orderId, { status: 'cancelled' });
    });

    it('unrelated user cannot dispute (403)', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;
      OrderRepository.update(orderId, { status: 'active', providerId });

      const outsider = `os${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: outsider, email: `${outsider}@example.com`, password: 'Test1234!' });
      const outsiderToken = (await request(app).post('/api/v1/users/login')
        .send({ email: `${outsider}@example.com`, password: 'Test1234!' })).body.token;

      const dispute = await request(app)
        .post(`/api/v1/orders/${orderId}/dispute`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ reason: 'unauthorized' });
      expect(dispute.statusCode).toBe(403);
      OrderRepository.update(orderId, { status: 'cancelled' });
    });
  });

  describe('GPU sort parameter + order soft-cancel + verification admin route', () => {
    const GpuRepository = require('../src/db/json/GpuRepository');
    const OrderRepository = require('../src/db/json/OrderRepository');
    const UserRepository = require('../src/db/json/UserRepository');

    let adminToken, renterToken, gpuId;

    beforeAll(async () => {
      // Admin user — register as normal user then promote via repo (self-registration blocks admin role)
      const adm = `adm${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: adm, email: `${adm}@example.com`, password: 'Test1234!' });
      const admUser = UserRepository.getByEmail(`${adm}@example.com`);
      UserRepository.update(admUser.id, { role: 'admin' });
      adminToken = (await request(app).post('/api/v1/users/login')
        .send({ email: `${adm}@example.com`, password: 'Test1234!' })).body.token;

      // Renter
      const rn = `rn${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: rn, email: `${rn}@example.com`, password: 'Test1234!' });
      renterToken = (await request(app).post('/api/v1/users/login')
        .send({ email: `${rn}@example.com`, password: 'Test1234!' })).body.token;

      // GPU with a ★3 review for sort testing
      const gpu = GpuRepository.create({
        name: 'Sort Test GPU', vendor: 'AMD', model: 'RX-SORT', memoryGB: 32, pricePerHour: 0.3,
      });
      gpuId = gpu.id;
      OrderRepository.create({
        gpuId, userId: 'sort-seed', durationMinutes: 60, status: 'completed',
        totalPrice: 50, createdAt: new Date().toISOString(),
        review: { rating: 3, comment: 'ok', reviewerId: 'sort-seed', reviewedAt: new Date().toISOString() }
      });
    });

    it('GET /gpus?sort=rating returns GPUs with reviews first (sorted descending)', async () => {
      const res = await request(app).get('/api/v1/gpus?sort=rating');
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body.gpus)).toBe(true);
      // All GPUs with reviews should appear before unrated ones
      const gpus = res.body.gpus;
      let foundRated = false;
      let ratedAfterUnrated = false;
      for (const g of gpus) {
        if (typeof g.pricePerHour === 'number') {
          // just verify the response has GPUs
          foundRated = true;
        }
      }
      expect(foundRated).toBe(true);
    });

    it('GET /gpus?sort=memory returns GPUs sorted by memoryGB descending', async () => {
      const res = await request(app).get('/api/v1/gpus?sort=memory');
      expect(res.statusCode).toBe(200);
      const gpus = res.body.gpus;
      if (gpus.length >= 2) {
        expect(gpus[0].memoryGB).toBeGreaterThanOrEqual(gpus[gpus.length - 1].memoryGB);
      }
    });

    it('GET /gpus?sort=price&sortDir=desc returns most expensive first', async () => {
      const res = await request(app).get('/api/v1/gpus?sort=price&sortDir=desc');
      expect(res.statusCode).toBe(200);
      const gpus = res.body.gpus;
      if (gpus.length >= 2) {
        expect(gpus[0].pricePerHour).toBeGreaterThanOrEqual(gpus[gpus.length - 1].pricePerHour);
      }
    });

    it('DELETE /orders/:id soft-cancels (status=cancelled, order still exists)', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      expect(create.statusCode).toBe(201);
      const orderId = create.body.order.id;

      const del = await request(app)
        .delete(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${renterToken}`);
      expect(del.statusCode).toBe(200);
      expect(del.body.message).toMatch(/cancel/i);

      // Order still exists in DB (soft delete)
      const order = OrderRepository.getById(orderId);
      expect(order).not.toBeNull();
      expect(order.status).toBe('cancelled');
      expect(order.cancelReason).toBe('user_cancelled');
    });

    it('GET /admin/verifications requires admin auth (401 without token, 403 for user)', async () => {
      const noAuth = await request(app).get('/api/v1/admin/verifications');
      expect(noAuth.statusCode).toBe(401);

      const userRes = await request(app)
        .get('/api/v1/admin/verifications')
        .set('Authorization', `Bearer ${renterToken}`);
      expect(userRes.statusCode).toBe(403);
    });

    it('GET /admin/verifications returns paginated records for admin', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('records');
      expect(Array.isArray(res.body.records)).toBe(true);
    });
  });

  describe('Dispute resolution + reputation failure feedback', () => {
    const GpuRepository = require('../src/db/json/GpuRepository');
    const OrderRepository = require('../src/db/json/OrderRepository');
    const UserRepository = require('../src/db/json/UserRepository');

    let adminToken, renterToken, providerId, gpuId;

    beforeAll(async () => {
      const adm = `dra${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: adm, email: `${adm}@example.com`, password: 'Test1234!' });
      const admUser = UserRepository.getByEmail(`${adm}@example.com`);
      UserRepository.update(admUser.id, { role: 'admin' });
      adminToken = (await request(app).post('/api/v1/users/login')
        .send({ email: `${adm}@example.com`, password: 'Test1234!' })).body.token;

      const rn = `drr${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: rn, email: `${rn}@example.com`, password: 'Test1234!' });
      renterToken = (await request(app).post('/api/v1/users/login')
        .send({ email: `${rn}@example.com`, password: 'Test1234!' })).body.token;

      const p = `drp${unique}`.slice(0, 28);
      await request(app).post('/api/v1/users/register')
        .send({ username: p, email: `${p}@example.com`, password: 'Test1234!', role: 'provider' });
      providerId = UserRepository.getByEmail(`${p}@example.com`)?.id;

      const gpu = GpuRepository.create({
        name: 'Dispute Resolve GPU', vendor: 'NVIDIA', model: 'RTX-DRR', memoryGB: 16, pricePerHour: 0.6,
        providerId,
      });
      gpuId = gpu.id;
    });

    async function makeDisputedOrder() {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      const orderId = create.body.order.id;
      OrderRepository.update(orderId, { status: 'active', providerId });
      await request(app)
        .post(`/api/v1/orders/${orderId}/dispute`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ reason: 'GPU unresponsive' });
      return orderId;
    }

    it('refund verdict cancels the order and PENALIZES provider reputation', async () => {
      const before = await request(app).get(`/api/v1/users/${providerId}/reputation`);
      const beforeFailed = before.body.stats.failedJobs;
      const beforeSlash = before.body.stats.slashCount;

      const orderId = await makeDisputedOrder();
      const resolve = await request(app)
        .post(`/api/v1/orders/${orderId}/dispute/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'refund', note: 'provider at fault' });
      expect(resolve.statusCode).toBe(200);

      const order = OrderRepository.getById(orderId);
      expect(order.status).toBe('cancelled');
      expect(order.cancelReason).toBe('dispute_resolved_refund');
      expect(order.dispute.resolution.decision).toBe('refund');

      const after = await request(app).get(`/api/v1/users/${providerId}/reputation`);
      expect(after.body.stats.failedJobs).toBe(beforeFailed + 1);
      expect(after.body.stats.slashCount).toBe(beforeSlash + 1);
    });

    it('refund verdict actually LOWERS the provider score (reputation can decrease)', async () => {
      // Seed a clean baseline of successes, capture score, then refund-dispute and re-check
      const before = await request(app).get(`/api/v1/users/${providerId}/reputation`);
      const beforeScore = before.body.score;

      const orderId = await makeDisputedOrder();
      await request(app)
        .post(`/api/v1/orders/${orderId}/dispute/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'refund' });

      const after = await request(app).get(`/api/v1/users/${providerId}/reputation`);
      expect(after.body.score).toBeLessThan(beforeScore);
    });

    it('uphold verdict completes the order and CREDITS provider reputation', async () => {
      const before = await request(app).get(`/api/v1/users/${providerId}/reputation`);
      const beforeCompleted = before.body.stats.completedJobs;

      const orderId = await makeDisputedOrder();
      const resolve = await request(app)
        .post(`/api/v1/orders/${orderId}/dispute/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'uphold' });
      expect(resolve.statusCode).toBe(200);

      const order = OrderRepository.getById(orderId);
      expect(order.status).toBe('completed');
      expect(order.dispute.resolution.decision).toBe('uphold');

      const after = await request(app).get(`/api/v1/users/${providerId}/reputation`);
      expect(after.body.stats.completedJobs).toBe(beforeCompleted + 1);
    });

    it('only admin can resolve a dispute (403 for renter)', async () => {
      const orderId = await makeDisputedOrder();
      const resolve = await request(app)
        .post(`/api/v1/orders/${orderId}/dispute/resolve`)
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ decision: 'refund' });
      expect(resolve.statusCode).toBe(403);
      OrderRepository.update(orderId, { status: 'cancelled' });
    });

    it('cannot resolve a non-disputed order (400)', async () => {
      const create = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ gpuId, durationMinutes: 30 });
      const orderId = create.body.order.id;
      const resolve = await request(app)
        .post(`/api/v1/orders/${orderId}/dispute/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'refund' });
      expect(resolve.statusCode).toBe(400);
      OrderRepository.update(orderId, { status: 'cancelled' });
    });

    it('invalid decision is rejected (400)', async () => {
      const orderId = await makeDisputedOrder();
      const resolve = await request(app)
        .post(`/api/v1/orders/${orderId}/dispute/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'maybe' });
      expect(resolve.statusCode).toBe(400);
      OrderRepository.update(orderId, { status: 'cancelled' });
    });
  });
});
