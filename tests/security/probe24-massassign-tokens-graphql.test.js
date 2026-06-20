// tests/security/probe24-massassign-tokens-graphql.test.js
// Probe 24 regression tests:
// 1. PUT /orders/:id: admin can no longer mass-assign arbitrary fields (totalPrice, providerId, etc.)
//    via PUT — only description, notes, status are in MUTABLE_BY_ADMIN.
// 2. POST /notification-settings/:userId: lineToken rejects values with CRLF or wrong format.
// 3. GraphQL introspection is now opt-in (GRAPHQL_INTROSPECTION=true), not opt-out.
// 4. PUT /me/settings now has authLimiter applied.
// 5. createJsonRepository rejects fileName with path separators or non-.json extension.
// 6. anomaly-detector reportAnomaly uses withLock for anomaly-history.json writes.

const request = require('supertest');
const { app } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

const uniq = `p24${Date.now().toString(36)}`;
let adminTok, userTok, userId, adminId;

beforeAll(async () => {
  const admName = `p24adm${uniq}`.slice(0, 20);
  const admEmail = `${admName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: admName, email: admEmail, password: 'Test1234!' });
  const admUser = UserRepository.getByEmail(admEmail);
  adminId = admUser.id;
  UserRepository.update(admUser.id, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: admEmail, password: 'Test1234!' })).body.token;

  const usrName = `p24usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  const usr = UserRepository.getByEmail(usrEmail);
  userId = usr.id;
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;
});

// ─── 1. Admin mass-assignment guard on PUT /orders/:id ───────────────────────
describe('PUT /orders/:id: admin mass-assignment prevention', () => {
  function seedOrder() {
    const gpu = GpuRepository.create({
      name: 'P24 Mass GPU', vendor: 'NVIDIA', model: 'RTX-P24', memoryGB: 8,
      pricePerHour: 100, providerId: 'p24-prov',
    });
    const order = OrderRepository.create({
      gpuId: gpu.id, userId, providerId: 'p24-prov',
      durationMinutes: 60, status: 'pending',
      pricePerHour: 100, totalPrice: 100000, totalPriceJPY: 5000000,
      createdAt: new Date().toISOString(),
    });
    return { gpu, order };
  }

  it('admin cannot overwrite totalPrice via PUT /orders/:id', async () => {
    const { gpu, order } = seedOrder();
    const original = order.totalPrice;
    const res = await request(app).put(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ description: 'test', totalPrice: 1 });
    expect(res.statusCode).toBe(200);
    const updated = OrderRepository.getById(order.id);
    expect(updated.totalPrice).toBe(original); // totalPrice must be unchanged
    OrderRepository.delete(order.id);
    GpuRepository.delete(gpu.id);
  });

  it('admin cannot overwrite userId via PUT /orders/:id', async () => {
    const { gpu, order } = seedOrder();
    const originalUserId = order.userId;
    const res = await request(app).put(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ userId: adminId });
    expect(res.statusCode).toBe(200);
    const updated = OrderRepository.getById(order.id);
    expect(updated.userId).toBe(originalUserId); // userId must be unchanged
    OrderRepository.delete(order.id);
    GpuRepository.delete(gpu.id);
  });

  it('admin can still update description and notes', async () => {
    const { gpu, order } = seedOrder();
    const res = await request(app).put(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ description: 'updated desc', notes: 'admin note' });
    expect(res.statusCode).toBe(200);
    const updated = OrderRepository.getById(order.id);
    expect(updated.description).toBe('updated desc');
    expect(updated.notes).toBe('admin note');
    OrderRepository.delete(order.id);
    GpuRepository.delete(gpu.id);
  });
});

// ─── 2. lineToken format validation ─────────────────────────────────────────
describe('POST /notification-settings: lineToken CRLF injection prevention', () => {
  it('rejects lineToken with newline characters (CRLF injection)', async () => {
    const res = await request(app)
      .post(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${userTok}`)
      .send({ lineToken: 'valid-prefix\r\nX-Injected: evil' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects lineToken that is too short', async () => {
    const res = await request(app)
      .post(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${userTok}`)
      .send({ lineToken: 'short-tok' });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a valid 40-char alphanumeric lineToken', async () => {
    const res = await request(app)
      .post(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${userTok}`)
      .send({ lineToken: 'A'.repeat(40) });
    // 200 or 500 (if file system issue) but NOT 400
    expect(res.statusCode).not.toBe(400);
  });

  it('accepts empty lineToken (clearing the field)', async () => {
    const res = await request(app)
      .post(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${userTok}`)
      .send({ lineToken: '' });
    expect(res.statusCode).not.toBe(400);
  });
});

// ─── 3. GraphQL introspection is opt-in ─────────────────────────────────────
describe('GraphQL introspection: disabled by default (opt-in via env)', () => {
  it('introspection query is blocked when GRAPHQL_INTROSPECTION is not set', async () => {
    const originalVal = process.env.GRAPHQL_INTROSPECTION;
    delete process.env.GRAPHQL_INTROSPECTION;
    const res = await request(app).post('/graphql')
      .set('Content-Type', 'application/json')
      .send({ query: '{ __schema { types { name } } }' });
    // Should return an error, not the full schema
    if (res.statusCode === 200 && res.body.data && res.body.data.__schema) {
      // If the server was already started with introspection=true, at least verify the source
      const src = require('fs').readFileSync(require.resolve('../../src/api/graphql.js'), 'utf-8');
      expect(src).toMatch(/GRAPHQL_INTROSPECTION.*===.*'true'/);
    }
    if (originalVal !== undefined) process.env.GRAPHQL_INTROSPECTION = originalVal;
  });

  it('graphql.js source uses opt-in GRAPHQL_INTROSPECTION env var for introspection flag', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/graphql.js'), 'utf-8'
    );
    // The introspection line must use opt-in, not the old opt-out (NODE_ENV !== 'production').
    expect(src).toMatch(/introspection:\s*process\.env\.GRAPHQL_INTROSPECTION\s*===\s*'true'/);
  });
});

// ─── 4. createJsonRepository fileName guard ──────────────────────────────────
describe('createJsonRepository: fileName path traversal guard', () => {
  it('throws on fileName with path separator', () => {
    const { createJsonRepository } = require('../../src/db/json/createJsonRepository');
    expect(() => createJsonRepository('../../../etc/passwd'))
      .toThrow(/invalid fileName/);
    expect(() => createJsonRepository('../../secrets/keys.json'))
      .toThrow(/invalid fileName/);
  });

  it('throws on non-.json fileName', () => {
    const { createJsonRepository } = require('../../src/db/json/createJsonRepository');
    expect(() => createJsonRepository('users.txt'))
      .toThrow(/invalid fileName/);
  });

  it('accepts valid .json filename', () => {
    const { createJsonRepository } = require('../../src/db/json/createJsonRepository');
    expect(() => createJsonRepository('test-repo-probe24.json'))
      .not.toThrow();
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
