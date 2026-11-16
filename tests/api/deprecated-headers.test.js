// tests/api/deprecated-headers.test.js — 非推奨パススルーの RFC 9745 ヘッダー契約を固定。
// /payment ルートは長らく「Deprecated endpoint ... accessed」の
// ログ警告のみで、クライアントへ機械判別可能な印が無かった。Deprecation(@unix秒)と
// Link(successor-version) が実際のレスポンスへ出ることを固定する。
// （旧 /order・/match は P2P 層の削除に伴い除去されたため対象から外した。）

const request = require('supertest');

jest.mock('../../lightning-service', () => ({
  LightningService: jest.fn().mockImplementation(() => ({
    async initialize() {},
    async payInvoice() { return { preimage: 'mock' }; },
  })),
}));

const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');

async function registerAndLogin(prefix) {
  const id = `${prefix}${Date.now()}${Math.floor(Math.random() * 1e4)}`.slice(0, 26);
  const email = `${id}@example.com`;
  const reg = await request(app).post('/api/v1/users/register').send({ username: id, email, password: 'Test1234!' });
  UserRepository.update(reg.body.user.id, { role: 'admin' });
  const login = await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' });
  return login.body.token;
}

describe('RFC 9745 Deprecation headers on deprecated pass-throughs', () => {
  let token;
  beforeAll(async () => { token = await registerAndLogin('dephdr'); });

  it('/payment exposes Deprecation + successor Link (even on validation 400)', async () => {
    const res = await request(app).post('/api/v1/payment').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
    expect(res.headers.deprecation).toMatch(/^@\d{10}$/);
    expect(res.headers.link).toContain('/api/v1/payments/pay');
  });

  it('non-deprecated routes do not carry the header', async () => {
    const res = await request(app).get('/api/v1/gpus').set('Authorization', `Bearer ${token}`);
    expect(res.headers.deprecation).toBeUndefined();
  });
});
