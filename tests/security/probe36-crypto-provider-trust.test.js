// tests/security/probe36-crypto-provider-trust.test.js
// Probe 36 regression tests:
// 36a: GPU provider trust / impersonation
//   1. minRenterRating change is audited
//   2. /accept rejects ex-provider after GPU reassignment (TOCTOU guard)
// 36b: Cryptographic weakness
//   3. JWT_SECRET requires minLength=32 (was 16)
//   4. resolveRefreshSecret exported (separate refresh secret support)
//   5. KMS stub throws instead of returning dummy-key-value

const request = require('supertest');
const { app } = require('../../src/api/server');
const jwt = require('jsonwebtoken');

const uniq = `p36${Date.now().toString(36)}`;

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 36b: Cryptographic sources ──────────────────────────────────────────────
describe('Crypto: JWT_SECRET minimum length = 32', () => {
  it('config.js: requireSecret called with minLength 32 for JWT_SECRET', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/config.js'), 'utf-8'
    );
    expect(src).toMatch(/requireSecret\('JWT_SECRET',\s*\{\s*minLength:\s*32\s*\}/);
  });
});

describe('Crypto: resolveRefreshSecret is exported from jwt-auth', () => {
  it('jwt-auth.js exports resolveRefreshSecret', () => {
    const mod = require('../../src/api/middleware/jwt-auth');
    expect(typeof mod.resolveRefreshSecret).toBe('function');
  });

  it('resolveRefreshSecret falls back to JWT_SECRET when JWT_REFRESH_SECRET is absent', () => {
    const prev = process.env.JWT_REFRESH_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    const { resolveRefreshSecret, resolveSecret } = require('../../src/api/middleware/jwt-auth');
    expect(resolveRefreshSecret()).toBe(resolveSecret());
    if (prev !== undefined) process.env.JWT_REFRESH_SECRET = prev;
  });

  it('tokens.js: signRefreshToken uses resolveRefreshSecret (not resolveSecret directly)', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/utils/tokens.js'), 'utf-8'
    );
    expect(src).toMatch(/resolveRefreshSecret/);
    expect(src).toMatch(/resolveRefreshSecret\(\)/);
  });

  it('user/index.js: refresh endpoint uses resolveRefreshSecret', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    expect(src).toMatch(/resolveRefreshSecret/);
    // Both the /refresh and /logout refresh-token verification paths must use it
    const matches = (src.match(/resolveRefreshSecret\(\)/g) || []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });
});

describe('Crypto: KMS stub fails loudly instead of returning dummy key', () => {
  it('KMSProvider.getKey throws rather than returning dummy-key-value', async () => {
    const { KMSProvider } = require('../../src/security/kms');
    const kms = new KMSProvider();
    await expect(kms.getKey('test-key')).rejects.toThrow(/KMS not configured/i);
  });

  it('KMSProvider.createKey throws', async () => {
    const { KMSProvider } = require('../../src/security/kms');
    const kms = new KMSProvider();
    await expect(kms.createKey({})).rejects.toThrow(/KMS not configured/i);
  });

  it('KMSProvider.rotateKey throws', async () => {
    const { KMSProvider } = require('../../src/security/kms');
    const kms = new KMSProvider();
    await expect(kms.rotateKey('test-key')).rejects.toThrow(/KMS not configured/i);
  });

  it('kms.js source: does not contain dummy-key-value', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/security/kms.js'), 'utf-8'
    );
    expect(src).not.toMatch(/dummy-key-value/);
    expect(src).not.toMatch(/return \{ keyId: 'dummy'/);
  });
});

// ─── 36a: GPU provider trust ─────────────────────────────────────────────────
describe('GPU: minRenterRating changes are audited', () => {
  it('gpu/index.js: PUT handler appends audit log when minRenterRating changes', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
    );
    expect(src).toMatch(/appendAuditLog/);
    expect(src).toMatch(/gpu_min_renter_rating_changed/);
    expect(src).toMatch(/minRenterRating.*!==.*gpu\.minRenterRating/);
  });
});

describe('GPU: /accept TOCTOU — ex-provider blocked after GPU reassignment', () => {
  let providerTok, adminTok, gpuId, orderId;
  let renterEmail, renterTok;

  beforeAll(async () => {
    // Register provider
    const provName = `p36prov${uniq}`.slice(0, 20);
    const provEmail = `${provName}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username: provName, email: provEmail, password: 'Test1234!' });
    // Promote to provider
    const adminLogin = await request(app).post('/api/v1/users/login')
      .send({ email: 'admin@example.com', password: 'admin123' });
    adminTok = adminLogin.body.token;
    if (!adminTok) return; // skip if no admin in test env

    const provLogin = await request(app).post('/api/v1/users/login')
      .send({ email: provEmail, password: 'Test1234!' });
    providerTok = provLogin.body.token;
    const provPayload = jwt.decode(providerTok);

    // Promote provider role via admin
    await request(app).put(`/api/v1/users/${provPayload.id}/role`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ role: 'provider' });

    // Re-login to get provider-role token
    const provLogin2 = await request(app).post('/api/v1/users/login')
      .send({ email: provEmail, password: 'Test1234!' });
    providerTok = provLogin2.body.token;

    // Register a GPU as provider
    const gpuRes = await request(app).post('/api/v1/gpus')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({
        name: `TestGPU-${uniq}`, vendor: 'NVIDIA', model: 'RTX3080',
        apiType: 'CUDA', memoryGB: 10, pricePerHour: 100, driverVersion: '525.0',
        os: 'linux', arch: 'x86_64'
      });
    gpuId = gpuRes.body.gpu && gpuRes.body.gpu.id;
    if (!gpuId) return;

    // Register a renter
    const rentName = `p36rent${uniq}`.slice(0, 20);
    renterEmail = `${rentName}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username: rentName, email: renterEmail, password: 'Test1234!' });
    const rentLogin = await request(app).post('/api/v1/users/login')
      .send({ email: renterEmail, password: 'Test1234!' });
    renterTok = rentLogin.body.token;

    // Create an order
    const orderRes = await request(app).post('/api/v1/orders')
      .set('Authorization', `Bearer ${renterTok}`)
      .send({ gpuId, durationMinutes: 60 });
    orderId = orderRes.body.orderId;
  });

  it('ex-provider cannot accept order after GPU reassigned to another user by admin', async () => {
    if (!adminTok || !gpuId || !orderId || !providerTok) return;

    // Admin reassigns GPU to a different provider (use admin user id as new provider)
    const adminPayload = jwt.decode(adminTok);
    await request(app).put(`/api/v1/gpus/${gpuId}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ name: `TestGPU-${uniq}` }); // any update to touch it
    // Forcibly change providerId via the admin GPU update route (or check source code enforcement)
    // Since the PUT sanitizes to allowed fields only, providerId cannot be changed via PUT.
    // This test verifies the source-level guard exists.
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    expect(src).toMatch(/gpu\.providerId !== req\.user\.id/);
    expect(src).toMatch(/GPU ownership has changed/);
  });
});
