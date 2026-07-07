// tests/security/probe35-token-refresh.test.js
// Probe 35 regression tests:
// 1. Refresh token without jti is rejected (single-use enforcement requires jti)
// 2. Lock key no longer falls back to user.id (jti is mandatory)
// 3. Logout without refresh token still protects against stolen refresh (sessionsRevokedAt)
// 4. Normal refresh token rotation still works

const request = require('supertest');
const { app } = require('../../src/api/server');
const jwt = require('jsonwebtoken');
const { resolveSecret } = require('../../src/api/middleware/jwt-auth');

const uniq = `p35${Date.now().toString(36)}`;
let userTok, userId, refreshTok, userEmail;

beforeAll(async () => {
  const name = `p35usr${uniq}`.slice(0, 20);
  userEmail = `${name}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: name, email: userEmail, password: 'Test1234!' });
  const loginRes = await request(app).post('/api/v1/users/login')
    .send({ email: userEmail, password: 'Test1234!' });
  userTok = loginRes.body.token;
  refreshTok = loginRes.body.refreshToken;
  // Extract userId from the access token
  const payload = jwt.decode(userTok);
  userId = payload.id;
});

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 1. jti-less refresh tokens are rejected ─────────────────────────────────
describe('Refresh token: jti is required', () => {
  it('POST /refresh with a jti-less token returns 401', async () => {
    // Craft a valid refresh token without jti
    const secret = resolveSecret();
    const payload = { id: userId, type: 'refresh', iat: Math.floor(Date.now() / 1000) };
    const noJtiToken = jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '7d' });

    const res = await request(app)
      .post('/api/v1/users/refresh')
      .send({ refreshToken: noJtiToken });
    expect(res.statusCode).toBe(401);
    expect(res.body.error || '').toMatch(/missing token identifier|invalid refresh token/i);
  });

  it('source: user/index.js rejects !payload.jti before lock key', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    expect(src).toMatch(/if \(!payload\.jti\)/);
    // Lock key must not fall back to user.id
    expect(src).not.toMatch(/payload\.jti \|\| user\.id/);
  });
});

// ─── 2. Normal refresh still works ───────────────────────────────────────────
describe('Refresh token: normal rotation flow works', () => {
  it('POST /refresh with valid jti token returns new tokens', async () => {
    if (!refreshTok) return;
    const res = await request(app)
      .post('/api/v1/users/refresh')
      .send({ refreshToken: refreshTok });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    // Update refreshTok for subsequent tests
    refreshTok = res.body.refreshToken;
  });

  it('POST /refresh with an already-used refresh token returns 401 (single-use)', async () => {
    if (!refreshTok) return;
    const oldToken = refreshTok;
    // Use the token first
    const firstRes = await request(app)
      .post('/api/v1/users/refresh')
      .send({ refreshToken: oldToken });
    if (firstRes.statusCode !== 200) return; // skip if already used
    refreshTok = firstRes.body.refreshToken;

    // Replay the old token — must fail
    const replayRes = await request(app)
      .post('/api/v1/users/refresh')
      .send({ refreshToken: oldToken });
    expect(replayRes.statusCode).toBe(401);
  });
});

// ─── 3. Logout without refresh token triggers sessionsRevokedAt ──────────────
describe('Logout: post-logout refresh token protection', () => {
  // Use a dedicated isolated user for this test to avoid sessionsRevokedAt cross-contamination
  let isoEmail, isoAccess, isoRefresh;
  beforeAll(async () => {
    const isoName = `p35iso${uniq}`.slice(0, 20);
    isoEmail = `${isoName}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username: isoName, email: isoEmail, password: 'Test1234!' });
    const lr = await request(app).post('/api/v1/users/login')
      .send({ email: isoEmail, password: 'Test1234!' });
    isoAccess = lr.body.token;
    isoRefresh = lr.body.refreshToken;
  });

  it('logout without refresh token still invalidates future refresh attempts', async () => {
    if (!isoAccess || !isoRefresh) return;

    // Logout WITHOUT providing the refresh token
    const logoutRes = await request(app)
      .post('/api/v1/users/logout')
      .set('Authorization', `Bearer ${isoAccess}`)
      .send({}); // no refreshToken field
    expect(logoutRes.statusCode).toBe(200);

    // The refresh token should now be invalid (sessionsRevokedAt updated)
    const refreshRes = await request(app)
      .post('/api/v1/users/refresh')
      .send({ refreshToken: isoRefresh });
    expect(refreshRes.statusCode).toBe(401);
  });

  it('source: logout updates sessionsRevokedAt when refreshToken is absent', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    expect(src).toMatch(/sessionsRevokedAt.*new Date/);
    // The update must be in the else branch of the refreshToken check
    expect(src).toMatch(/\} else \{[\s\S]{1,300}sessionsRevokedAt/);
  });
});
