// tests/security/probe23a-google-oauth-refresh.test.js
// Probe 23a regression tests:
// POST /users/refresh is protected by withLock, making single-use
// enforcement race-free (verify OWASP reuse-detection still works correctly).
// (The POST /auth/google idToken endpoint was removed — google-auth-library
// is not installed so it could never verify a token.)

const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');

// ─── Refresh token: withLock makes single-use race-proof ──────────────────
describe('POST /users/refresh: single-use enforcement', () => {
  const uniq = `p23a${Date.now().toString(36)}`;
  const email = `${uniq}@example.com`;
  const username = uniq.slice(0, 20);
  let accessToken, refreshToken;

  beforeAll(async () => {
    await request(app).post('/api/v1/users/register')
      .send({ username, email, password: 'Test1234!' });
    const login = await request(app).post('/api/v1/users/login')
      .send({ email, password: 'Test1234!' });
    accessToken = login.body.token;
    refreshToken = login.body.refreshToken;
  });

  it('first use of a refresh token returns a new token pair', async () => {
    const res = await request(app).post('/api/v1/users/refresh')
      .send({ refreshToken });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    // Keep the new token for the reuse check below.
    refreshToken = res.body.refreshToken;
  });

  it('replaying an already-used refresh token is rejected (reuse-detection)', async () => {
    // Use the new refresh token once to advance the chain.
    const first = await request(app).post('/api/v1/users/refresh')
      .send({ refreshToken });
    expect(first.statusCode).toBe(200);
    const used = refreshToken; // The token we just consumed.

    // Replay the consumed token — must be rejected.
    const replay = await request(app).post('/api/v1/users/refresh')
      .send({ refreshToken: used });
    expect(replay.statusCode).toBe(401);
  });

  it('withLock guard is present in refresh route source', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/api/routes/user/auth.js'), 'utf-8');
    // The lock key is constructed as `refresh:${jti}` and passed to withLock.
    expect(src).toMatch(/refresh:/);
    expect(src).toMatch(/withLock\(lockKey/);
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
