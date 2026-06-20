// tests/security/probe17-marketplace-lock.test.js
// Probe 17 regression tests:
// 1. /escrow/:id/resolve now uses withLock — mismatched providerId returns 400, unknown escrow 404
// 2. notification-settings loadSettings() is fail-closed on corrupt JSON

const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

const SETTINGS_PATH = path.join(__dirname, '../../data/notification-settings.json');

const uniq = `p17${Date.now().toString(36)}`;
let adminTok;
let userTok;
let adminId;

beforeAll(async () => {
  const admName = `p17adm${uniq}`.slice(0, 20);
  const admEmail = `${admName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: admName, email: admEmail, password: 'Test1234!' });
  const admUser = UserRepository.getByEmail(admEmail);
  adminId = admUser.id;
  UserRepository.update(admUser.id, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: admEmail, password: 'Test1234!' })).body.token;

  const usrName = `p17usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;
});

const asAdmin = (r) => r.set('Authorization', `Bearer ${adminTok}`);
const asUser = (r) => r.set('Authorization', `Bearer ${userTok}`);

function seedEscrowedOrder(providerId = 'prov-p17-test') {
  const gpu = GpuRepository.create({
    name: 'P17 Test GPU', vendor: 'NVIDIA', model: 'RTX-P17', memoryGB: 8,
    pricePerHour: 100, providerId,
  });
  return OrderRepository.create({
    gpuId: gpu.id, userId: 'user-p17-test', providerId,
    durationMinutes: 60, status: 'matched',
    pricePerHour: 100, totalPrice: 100, totalPriceJPY: 5000000,
    createdAt: new Date().toISOString(),
  });
}

describe('escrow /resolve: withLock + providerId validation', () => {
  it('rejects non-admin with 403', async () => {
    const res = await asUser(request(app).post('/api/v1/marketplace/escrow/any-id/resolve'))
      .send({ decision: 'settle' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects invalid decision with 400', async () => {
    const res = await asAdmin(request(app).post('/api/v1/marketplace/escrow/any-id/resolve'))
      .send({ decision: 'invalid' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/decision must be/);
  });

  it('returns 404 when escrow does not exist and providerId is given', async () => {
    const res = await asAdmin(request(app).post('/api/v1/marketplace/escrow/does-not-exist/resolve'))
      .send({ decision: 'refund', providerId: 'some-provider' });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/escrow not found/);
  });

  it('returns 400 when providerId does not match the escrow order provider', async () => {
    const order = seedEscrowedOrder('real-provider-id');
    // Open escrow
    const opened = await asAdmin(request(app).post('/api/v1/marketplace/escrow/open'))
      .send({ orderId: order.id, feeRate: 0 });
    expect(opened.statusCode).toBe(201);
    const escrowId = opened.body.escrow.id;

    // Attempt resolve with wrong providerId
    const res = await asAdmin(request(app).post(`/api/v1/marketplace/escrow/${escrowId}/resolve`))
      .send({ decision: 'refund', providerId: 'WRONG-provider-id' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/providerId does not match/);

    OrderRepository.update(order.id, { status: 'cancelled' });
  });
});

describe('notification-settings: loadSettings() fail-closed on corrupt JSON', () => {
  const backupPath = `${SETTINGS_PATH}.bak`;

  afterEach(() => {
    // Restore backup if it exists
    if (fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, SETTINGS_PATH);
    } else if (fs.existsSync(SETTINGS_PATH)) {
      // Clean up any file written during test
      try { fs.unlinkSync(SETTINGS_PATH); } catch (_) {}
    }
  });

  it('POST returns 500 when settings file contains corrupt JSON (not [])', async () => {
    // Back up existing file
    if (fs.existsSync(SETTINGS_PATH)) fs.copyFileSync(SETTINGS_PATH, backupPath);

    // Write corrupt JSON
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, '{INVALID JSON!!!', 'utf-8');

    const res = await asAdmin(request(app).post(`/api/v1/notification-settings/${adminId}`))
      .send({ lineToken: 'A'.repeat(40) }); // valid-format 40-char token so Joi passes
    expect(res.statusCode).toBe(500);

    // Settings file should NOT have been overwritten with just this user's data
    // (because the write never happened after the parse failure)
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      expect(raw).toBe('{INVALID JSON!!!');
    }
  });

  it('POST returns 500 when settings file is a JSON array (not object)', async () => {
    if (fs.existsSync(SETTINGS_PATH)) fs.copyFileSync(SETTINGS_PATH, backupPath);

    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, '["corrupted","array"]', 'utf-8');

    const res = await asAdmin(request(app).post(`/api/v1/notification-settings/${adminId}`))
      .send({ lineToken: 'B'.repeat(40) }); // valid-format 40-char token so Joi passes
    expect(res.statusCode).toBe(500);
  });

  it('GET /notification-settings/:userId works normally when file is absent', async () => {
    if (fs.existsSync(SETTINGS_PATH)) fs.copyFileSync(SETTINGS_PATH, backupPath);
    if (fs.existsSync(SETTINGS_PATH)) fs.unlinkSync(SETTINGS_PATH);

    const res = await asAdmin(request(app).get(`/api/v1/notification-settings/${adminId}`));
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({});
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
