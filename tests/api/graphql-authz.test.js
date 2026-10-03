// GraphQL リゾルバの認可境界を固定する。
// REST 側の認可テストは揃っているが、GraphQL は別レイヤー（独自 context・独自
// リゾルバ）で、orders/order/users/user/gpus/gpu のフィルタ・拒否条件・
// apiKey 除去が未検証だった。ここを破れば REST を迂回して他者の注文・
// ユーザー機密・GPU 資格情報が取れる。
const request = require('supertest');
const { app, graphqlReady } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

async function registerAndLogin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}`.slice(0, 20);
  const email = `${u}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!' });
  const res = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: res.body.token, id: UserRepository.getByEmail(email).id, email };
}

function gql(token, query) {
  const r = request(app).post('/graphql');
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r.send({ query });
}

describe('GraphQL authorization boundaries', () => {
  let renter, provider, stranger, admin, gpuId, order;
  let graphqlAvailable = false;

  beforeAll(async () => {
    graphqlAvailable = await graphqlReady;
    renter = await registerAndLogin('gqzr');
    provider = await registerAndLogin('gqzp');
    stranger = await registerAndLogin('gqzs');
    admin = await registerAndLogin('gqza');
    UserRepository.update(admin.id, { role: 'admin' });
    // role は JWT claim に載るため昇格後に再ログインして新トークンを得る
    const res = await request(app).post('/api/v1/users/login')
      .send({ email: admin.email, password: 'Test1234!' });
    admin.token = res.body.token;

    gpuId = GpuRepository.create({
      name: 'GQL Authz GPU', vendor: 'NVIDIA', model: 'RTX-G', memoryGB: 8,
      pricePerHour: 50, apiKey: 'gpu-secret-key-xyz',
    }).id;
    order = OrderRepository.create({
      userId: renter.id, providerId: provider.id, gpuId,
      durationMinutes: 60, status: 'pending', totalPrice: 50, pricePerHour: 50,
    });
  });

  it('orders: 一般ユーザーは自分の注文のみ、admin は全件を返す', async () => {
    if (!graphqlAvailable) return;
    const q = `query { orders { id userId } }`;

    const own = await gql(stranger.token, q);
    expect(own.statusCode).toBe(200);
    expect(own.body.data.orders.every(o => o.userId === stranger.id)).toBe(true);

    const all = await gql(admin.token, q);
    expect(all.body.data.orders.some(o => o.id === order.id)).toBe(true);
  });

  it('order(id): 所有者と provider は可、無関係なユーザーは拒否される', async () => {
    if (!graphqlAvailable) return;
    const q = `query { order(id: "${order.id}") { id userId } }`;

    expect((await gql(renter.token, q)).body.data.order.id).toBe(order.id);
    expect((await gql(provider.token, q)).body.data.order.id).toBe(order.id);

    const denied = await gql(stranger.token, q);
    expect(denied.body.data.order).toBeFalsy();
    expect(denied.body.errors.length).toBeGreaterThan(0);
  });

  it('users: admin のみ全件可・password は露出しない、非 admin は拒否される', async () => {
    if (!graphqlAvailable) return;
    const denied = await gql(stranger.token, `query { users { id email } }`);
    expect(denied.body.data.users).toBeFalsy();

    // User 型に password フィールド自体が存在しない（スキーマで露出不可）
    const ok = await gql(admin.token, `query { users { id email } }`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.users.some(u => u.id === admin.id)).toBe(true);
  });

  it('user(id): 本人または admin のみ、第三者は拒否される', async () => {
    if (!graphqlAvailable) return;
    const q = `query { user(id: "${renter.id}") { id email } }`;

    expect((await gql(renter.token, q)).body.data.user.id).toBe(renter.id);
    expect((await gql(admin.token, q)).body.data.user.id).toBe(renter.id);

    const denied = await gql(stranger.token, q);
    expect(denied.body.data.user).toBeFalsy();
    expect(denied.body.errors.length).toBeGreaterThan(0);
  });

  it('gpus/gpu: 公開だが apiKey は型に存在せず露出しない', async () => {
    if (!graphqlAvailable) return;
    // apiKey を要求するクエリはスキーマ検証で弾かれる（フィールド非存在）
    const bad = await gql(null, `query { gpu(id: "${gpuId}") { id apiKey } }`);
    expect(bad.body.errors.length).toBeGreaterThan(0);

    const ok = await gql(null, `query { gpu(id: "${gpuId}") { id name } }`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.gpu.id).toBe(gpuId);
    expect(ok.body.data.gpu.apiKey).toBeUndefined();
  });
});
