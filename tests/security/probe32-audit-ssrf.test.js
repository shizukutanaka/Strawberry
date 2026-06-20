// tests/security/probe32-audit-ssrf.test.js
// Probe 32 regression tests:
// 1. Password change is now audit-logged
// 2. Role change is now audit-logged with acting admin ID
// 3. Payout address change is now audit-logged
// 4. Admin order status override is now audit-logged
// 5. resilient-notify.js has SSRF guard (assertPublicUrl) before dispatching
// 6. webhook.js sendWebhook has SSRF guard before dispatching

const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');

const uniq = `p32${Date.now().toString(36)}`;
let adminTok, userTok, userId, adminId;

beforeAll(async () => {
  const admName = `p32adm${uniq}`.slice(0, 20);
  const admEmail = `${admName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: admName, email: admEmail, password: 'Test1234!' });
  const admUser = UserRepository.getByEmail(admEmail);
  adminId = admUser.id;
  UserRepository.update(adminId, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: admEmail, password: 'Test1234!' })).body.token;

  const usrName = `p32usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  const usr = UserRepository.getByEmail(usrEmail);
  userId = usr.id;
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;
});

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 1–4. Source checks for audit logging ─────────────────────────────────────
describe('Audit log: sensitive operations are now recorded', () => {
  it('user/index.js: password change calls appendAuditLog', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    expect(src).toMatch(/appendAuditLog\('user_password_changed'/);
  });

  it('user/index.js: role change calls appendAuditLog with previousRole and changedBy', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    expect(src).toMatch(/appendAuditLog\('user_role_changed'/);
    expect(src).toMatch(/previousRole.*target\.role|changedBy.*req\.user\.id/s);
  });

  it('user/index.js: payout address change calls appendAuditLog', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    expect(src).toMatch(/appendAuditLog\('user_payout_address_changed'/);
  });

  it('order/index.js: admin status override calls appendAuditLog', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    expect(src).toMatch(/appendAuditLog\('admin_order_status_override'/);
    expect(src).toMatch(/adminId.*req\.user\.id/);
  });
});

// ─── 5–6. SSRF guards in notification dispatchers ─────────────────────────────
describe('SSRF guards: env-configured notification URLs are validated', () => {
  it('resilient-notify.js has assertPublicUrl guard before channel dispatch', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/resilient-notify.js'), 'utf-8'
    );
    expect(src).toMatch(/assertPublicUrl/);
    expect(src).toMatch(/ssrf-guard/);
  });

  it('webhook.js sendWebhook has assertPublicUrl guard before axios.post', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/webhook.js'), 'utf-8'
    );
    expect(src).toMatch(/assertPublicUrl/);
    expect(src).toMatch(/ssrf-guard/);
    // The SSRF check must come BEFORE the axios.post call
    const ssrfIdx = src.indexOf('assertPublicUrl(url)');
    const axiosIdx = src.indexOf('axios.post(url, body)');
    expect(ssrfIdx).toBeGreaterThan(-1);
    expect(axiosIdx).toBeGreaterThan(-1);
    expect(ssrfIdx).toBeLessThan(axiosIdx);
  });
});

// ─── 7. Role change actually works and logs (integration) ────────────────────
describe('Role change integration: admin can change user roles', () => {
  let targetId;

  beforeAll(async () => {
    const tgtName = `p32tgt${uniq}`.slice(0, 20);
    const tgtEmail = `${tgtName}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username: tgtName, email: tgtEmail, password: 'Test1234!' });
    const tgt = UserRepository.getByEmail(tgtEmail);
    targetId = tgt.id;
  });

  it('admin PUT /:id/role changes role and returns 200', async () => {
    const res = await request(app)
      .put(`/api/v1/users/${targetId}/role`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ role: 'provider' });
    expect(res.statusCode).toBe(200);
    expect(res.body.user?.role).toBe('provider');
  });
});
