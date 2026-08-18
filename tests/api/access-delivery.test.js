// tests/api/access-delivery.test.js
// GPU アクセスの受け渡し — プロダクトが売っているものが実際に届くか。
//
// 着手前は、支払って注文が active になっても借り手が受け取るのは `endpoint: null` /
// `deliveryImplemented: false` だった。サーバが他人のマシンの GPU を「割り当てる」という
// 前提自体が誤りで、接続手段を作れるのはプロバイダだけである。ここではその訂正後の経路
// （プロバイダが投入 → サーバが仲介 → 支払い済みの借り手だけが受け取る）を検証する。
//
// 認証情報を扱うので、重点は「誰が受け取れないか」に置く。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');
const PaymentRepository = require('../../src/db/json/PaymentRepository');

const uniq = Date.now().toString(36);
let provider, renter, outsider, admin;

async function mkUser(prefix, role) {
  const name = `${prefix}${uniq}`.slice(0, 20);
  const email = `${name}@example.com`;
  await request(app).post('/api/v1/users/register').send({ username: name, email, password: 'Test1234!' });
  const u = UserRepository.getByEmail(email);
  if (role) UserRepository.update(u.id, { role });
  const token = (await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' })).body.token;
  return { id: u.id, token };
}

beforeAll(async () => {
  provider = await mkUser('accprov', 'provider');
  renter = await mkUser('accrent');
  outsider = await mkUser('accout');
  admin = await mkUser('accadm', 'admin');
});

function seedOrder({ status = 'active', paid = true } = {}) {
  const gpu = GpuRepository.create({
    name: `Access GPU ${Math.random().toString(36).slice(2, 8)}`,
    vendor: 'NVIDIA', model: 'RTX 4090', apiType: 'CUDA',
    memoryGB: 24, clockMHz: 2500, powerWatt: 450, pricePerHour: 1000,
    providerId: provider.id, available: true,
  });
  const order = OrderRepository.create({
    userId: renter.id, providerId: provider.id, gpuId: gpu.id, durationMinutes: 60,
    status, pricePerHour: 1000, totalPrice: 1000, startedAt: new Date().toISOString(),
  });
  if (paid) {
    PaymentRepository.create({
      orderId: order.id, userId: renter.id, amount: 1000, method: 'bank_transfer', status: 'paid',
    });
  }
  return { gpu, order };
}

const ACCESS = { method: 'ssh', endpoint: 'gpu1.example.com:2222', username: 'renter', credential: 'super-secret-key', instructions: 'ssh -p 2222' };
const deliver = (id, token, body = ACCESS) =>
  request(app).post(`/api/v1/orders/${id}/access`).set('Authorization', `Bearer ${token}`).send(body);
const fetchAccess = (id, token) =>
  request(app).get(`/api/v1/orders/${id}/access`).set('Authorization', `Bearer ${token}`);

describe('the product actually delivers: provider → server → renter', () => {
  it('lets the provider deliver and the paying renter receive the connection details', async () => {
    const { order } = seedOrder();
    const posted = await deliver(order.id, provider.token);
    expect(posted.status).toBe(201);
    expect(posted.body.accessDelivery).toMatchObject({ delivered: true, method: 'ssh', hasCredential: true });

    const got = await fetchAccess(order.id, renter.token);
    expect(got.status).toBe(200);
    expect(got.body.access).toMatchObject({
      method: 'ssh', endpoint: 'gpu1.example.com:2222', username: 'renter',
      credential: 'super-secret-key', instructions: 'ssh -p 2222',
    });
  });

  it('stores the credential encrypted at rest, never in plaintext', async () => {
    // data/orders.json が漏れただけで全レンタルの認証情報が渡るのは論外
    const { order } = seedOrder();
    await deliver(order.id, provider.token);
    const stored = OrderRepository.getById(order.id).accessDelivery;
    expect(stored.credentialSealed).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain('super-secret-key');
    // AES-256-GCM の <iv>:<tag>:<ciphertext> 形式
    expect(stored.credentialSealed).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
  });

  it('tells the renter honestly when the provider has not delivered yet', async () => {
    const { order } = seedOrder();
    const got = await fetchAccess(order.id, renter.token);
    // 「まだ配信されていない」は稼働中レンタルの正常な状態。エラーとして返さない。
    expect(got.status).toBe(200);
    expect(got.body.delivered).toBe(false);
    expect(got.body.access).toBeNull();
  });
});

describe('who must not receive the credential', () => {
  it('refuses an unrelated user', async () => {
    const { order } = seedOrder();
    await deliver(order.id, provider.token);
    expect((await fetchAccess(order.id, outsider.token)).status).toBe(403);
  });

  it('refuses the provider itself — no need to hand the secret back out', async () => {
    const { order } = seedOrder();
    await deliver(order.id, provider.token);
    expect((await fetchAccess(order.id, provider.token)).status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const { order } = seedOrder();
    expect((await request(app).get(`/api/v1/orders/${order.id}/access`)).status).toBe(401);
  });

  it('refuses a renter who has not paid', async () => {
    // 未払いで接続情報を渡すと、支払わずに GPU を使えてしまう
    const { order } = seedOrder({ paid: false });
    await deliver(order.id, provider.token);
    const got = await fetchAccess(order.id, renter.token);
    expect(got.status).toBe(402);
  });

  it('stops serving access once the rental is no longer running', async () => {
    const { order } = seedOrder();
    await deliver(order.id, provider.token);
    OrderRepository.update(order.id, { status: 'completed' });
    expect((await fetchAccess(order.id, renter.token)).status).toBe(409);
  });
});

describe('who may deliver', () => {
  it('refuses the renter and unrelated users', async () => {
    const { order } = seedOrder();
    expect((await deliver(order.id, renter.token)).status).toBe(403);
    expect((await deliver(order.id, outsider.token)).status).toBe(403);
  });

  it('refuses delivery for a rental that is not running', async () => {
    const { order } = seedOrder({ status: 'pending' });
    expect((await deliver(order.id, provider.token)).status).toBe(400);
  });

  it('lets an admin deliver (operator support path)', async () => {
    const { order } = seedOrder();
    expect((await deliver(order.id, admin.token)).status).toBe(201);
  });
});

describe('the sealed credential never leaks through the generic order endpoints', () => {
  it('is not present in GET /orders/:id', async () => {
    const { order } = seedOrder();
    await deliver(order.id, provider.token);
    const res = await request(app).get(`/api/v1/orders/${order.id}`).set('Authorization', `Bearer ${renter.token}`);
    expect(res.status).toBe(200);
    // 要約だけが出る。暗号文であっても配る理由が無い。
    expect(res.body.order.accessDelivery).toMatchObject({ delivered: true, hasCredential: true });
    expect(res.body.order.accessDelivery.credentialSealed).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('super-secret-key');
  });

  it('is not present in GET /orders', async () => {
    const { order } = seedOrder();
    await deliver(order.id, provider.token);
    const res = await request(app).get('/api/v1/orders?limit=200').set('Authorization', `Bearer ${renter.token}`);
    expect(res.status).toBe(200);
    const found = res.body.orders.find((o) => o.id === order.id);
    expect(found.accessDelivery.credentialSealed).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('super-secret-key');
  });
});

describe('input validation', () => {
  it('rejects a dangerous endpoint scheme', async () => {
    const { order } = seedOrder();
    for (const endpoint of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      const res = await deliver(order.id, provider.token, { ...ACCESS, endpoint });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a missing endpoint and an unknown method', async () => {
    const { order } = seedOrder();
    expect((await deliver(order.id, provider.token, { ...ACCESS, endpoint: '' })).status).toBe(400);
    expect((await deliver(order.id, provider.token, { ...ACCESS, method: 'telepathy' })).status).toBe(400);
  });

  it('accepts host:port and ssh/https URLs', async () => {
    const { order } = seedOrder();
    for (const endpoint of ['gpu.example.com', 'gpu.example.com:22', 'ssh://gpu.example.com:22', 'https://gpu.example.com:8888']) {
      expect((await deliver(order.id, provider.token, { ...ACCESS, endpoint })).status).toBe(201);
    }
  });
});

describe('lifecycle', () => {
  it('purges the access details when the rental ends', async () => {
    // 終わった注文の SSH 鍵を持ち続ける理由は無い
    const { order } = seedOrder();
    await deliver(order.id, provider.token);
    expect(OrderRepository.getById(order.id).accessDelivery).not.toBeNull();

    const stopped = await request(app).post(`/api/v1/orders/${order.id}/stop`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(stopped.status).toBe(200);
    expect(OrderRepository.getById(order.id).accessDelivery).toBeNull();
  });
});
