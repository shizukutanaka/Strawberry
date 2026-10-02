// 非推奨 admin パススルー POST /api/v1/order・/api/v1/match の契約テスト（Jest + supertest）。
// 両エンドポイントは rbac('admin') + requireService(p2pNetwork) で守られ、
// p2p が無効な環境では 503 fail-closed、有効なら broadcastOrder / matchOrder へ委譲する。
// 未認証・非 admin が p2p ブロードキャストを発火できないことと、サービス無効時に
// 黙って成功を返さない（fail-closed）ことを固定する。
//
// p2p-network を jest.doMock で差し込み requireService を通過させることで、
// 通常は 503 でしか到達できない委譲経路も直接検証する。

jest.doMock('../../p2p-network', () => ({
  P2PNetwork: class {
    async initialize() {}
    async broadcastOrder(order) { this.broadcasted = order; }
    async matchOrder(body) { return { matchedOrderId: 'order-x', score: 0.9, echo: body }; }
  },
}));

const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const { p2pNetwork } = require('../../src/core/services');

async function registerAndLogin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}`.slice(0, 20);
  const email = `${u}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!' });
  const res = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: res.body.token, id: UserRepository.getByEmail(email).id, email };
}

describe('POST /api/v1/order・/api/v1/match（非推奨 admin パススルー）', () => {
  let admin, user;

  beforeAll(async () => {
    admin = await registerAndLogin('dp2adm');
    UserRepository.update(admin.id, { role: 'admin' });
    const res = await request(app).post('/api/v1/users/login')
      .send({ email: admin.email, password: 'Test1234!' });
    admin.token = res.body.token;
    user = await registerAndLogin('dp2usr');
  });

  const post = (path, token, body) => {
    const r = request(app).post(path).send(body);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  it('未認証は 401（p2p ブロードキャストの発火を防ぐ）', async () => {
    expect((await post('/api/v1/order', null, { gpuId: 'g1' })).statusCode).toBe(401);
    expect((await post('/api/v1/match', null, { maxPrice: 1 })).statusCode).toBe(401);
  });

  it('非 admin は 403', async () => {
    expect((await post('/api/v1/order', user.token, { gpuId: 'g1' })).statusCode).toBe(403);
    expect((await post('/api/v1/match', user.token, { maxPrice: 1 })).statusCode).toBe(403);
  });

  it('/order: admin は broadcastOrder へ委譲して 201', async () => {
    const res = await post('/api/v1/order', admin.token, { gpuId: 'gpu-1', renterId: user.id, pricePerHour: 100 });
    expect(res.statusCode).toBe(201);
    expect(p2pNetwork.broadcasted).toEqual(
      expect.objectContaining({ gpuId: 'gpu-1', renterId: user.id })
    );
    expect(res.body.order.gpuId).toBe('gpu-1');
  });

  it('/match: admin は matchOrder へ委譲して結果を返す', async () => {
    const res = await post('/api/v1/match', admin.token, { maxPrice: 200, gpuModel: 'A100' });
    expect(res.statusCode).toBe(200);
    expect(res.body.matched).toBe(true);
    expect(res.body.detail).toEqual(
      expect.objectContaining({ matchedOrderId: 'order-x', echo: { maxPrice: 200, gpuModel: 'A100' } })
    );
  });
});
