// 非推奨 admin パススルー POST /api/v1/payment の資金ガード契約を固定する。
// このエンドポイントは運営 LND ノードから任意 BOLT11 へ送金できるため、
// BOLT11 形式チェック + orderId 必須 + 注文額上限 の3層が無いと
// admin トークン漏洩 = ノード残高全損になる。admin 限定でも防御は必須。
const request = require('supertest');
const UserRepository = require('../../src/db/json/UserRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');

// lightning-service をモックして requireService ゲートを通過させる。
// （実サービスは LND ノード必須のためテスト環境では null → 常に503になり検証不能）
jest.doMock('../../lightning-service', () => ({
  LightningService: class {
    async initialize() {}
    async payInvoice() { return { preimage: 'mock-preimage' }; }
  },
}));

const { app } = require('../../src/api/server');

async function registerAndLogin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}`.slice(0, 20);
  const email = `${u}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!' });
  const res = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: res.body.token, id: UserRepository.getByEmail(email).id, email };
}

describe('POST /api/v1/payment (deprecated admin pass-through) の資金ガード', () => {
  let admin, user, order;
  const VALID_BOLT11 = 'lnbc100n1ptestinvoice';

  beforeAll(async () => {
    admin = await registerAndLogin('dpgadm');
    UserRepository.update(admin.id, { role: 'admin' });
    const res = await request(app).post('/api/v1/users/login')
      .send({ email: admin.email, password: 'Test1234!' });
    admin.token = res.body.token;
    user = await registerAndLogin('dpgusr');
    order = OrderRepository.create({
      userId: user.id, gpuId: 'gpu-x', durationMinutes: 60,
      status: 'pending', totalPrice: 100, pricePerHour: 100,
    });
  });

  const post = (token, body) => request(app).post('/api/v1/payment')
    .set('Authorization', `Bearer ${token}`).send(body);

  it('未認証は 401、非 admin は 403', async () => {
    expect((await request(app).post('/api/v1/payment').send({})).statusCode).toBe(401);
    expect((await post(user.token, {})).statusCode).toBe(403);
  });

  it('BOLT11 形式でない paymentRequest は 400', async () => {
    const res = await post(admin.token, { paymentRequest: 'not-an-invoice', orderId: order.id });
    expect(res.statusCode).toBe(400);
  });

  it('orderId 欠落は 400（送金は必ず実在注文に束縛）', async () => {
    const res = await post(admin.token, { paymentRequest: VALID_BOLT11 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/orderId/);
  });

  it('存在しない orderId は 404', async () => {
    const res = await post(admin.token, { paymentRequest: VALID_BOLT11, orderId: 'no-such-order' });
    expect(res.statusCode).toBe(404);
  });

  it('注文額（totalPrice+5%）を超える amount は 400', async () => {
    const res = await post(admin.token, {
      paymentRequest: VALID_BOLT11, orderId: order.id, amount: 999999,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/exceeding/);
  });

  it('負・非有限の amount は 400', async () => {
    for (const amount of [-5, 0, 'abc', NaN]) {
      const res = await post(admin.token, {
        paymentRequest: VALID_BOLT11, orderId: order.id, amount,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('有効な入力は lightning.payInvoice まで到達して送金される', async () => {
    const res = await post(admin.token, {
      paymentRequest: VALID_BOLT11, orderId: order.id, amount: 50,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('paid');
  });
});
