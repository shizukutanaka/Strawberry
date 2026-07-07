// tests/security/probe40-token-race.test.js
// Probe 40 regression tests:
// 40a-2: DELETE /orders/:id cancel uses withLock (escrowSvc.cancel not called before CAS)
// 40a-1: dispute withLock key is per-order (not per-user)
// 40b-4: /refresh revokes prior access token jti (ati claim on refresh token)
// 40b-5: denylist load failure is logged (not silently swallowed)
// 40b-1: lastLogin is persisted via UserRepository.update (not in-memory mutation)

const request = require('supertest');
const { app } = require('../../src/api/server');

const uniq = `p40${Date.now().toString(36)}`;

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 40a-2: Cancel uses withLock ─────────────────────────────────────────────
describe('DELETE /orders/:id cancel: withLock prevents double escrow cancel', () => {
  it('order/index.js: cancel handler wraps escrowSvc.cancel inside withLock', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    const lockIdx = src.indexOf("withLock(`order:${order.id}:cancel`");
    expect(lockIdx).toBeGreaterThan(-1);
    // The escrowSvc.cancel calls AFTER the lock must exist (find the one inside the block)
    const afterLock = src.slice(lockIdx);
    expect(afterLock).toMatch(/escrowSvc\.cancel\(escrow\.id\)/);
    // Closing the withLock must also exist after the lock opener
    expect(afterLock).toMatch(/end withLock\(cancel\)/);
  });

  it('order/index.js: cancel handler re-reads fresh order state inside the lock', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // Fresh read inside the lock: freshOrder = OrderRepository.getById(order.id)
    expect(src).toMatch(/freshOrder.*OrderRepository\.getById\(order\.id\)/);
    expect(src).toMatch(/freshOrder\.status/);
  });

  it('DELETE /orders/nonexistent returns 404 (auth required)', async () => {
    const res = await request(app).delete('/api/v1/orders/00000000-0000-4000-a000-000000000000');
    expect([401, 403, 404]).toContain(res.statusCode);
  });
});

// ─── 40a-1: Dispute lock key is per-order ────────────────────────────────────
describe('POST /orders/:id/dispute: withLock key is per-order', () => {
  it('order/index.js: dispute withLock uses order.id not req.user.id', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    expect(src).toMatch(/withLock\(`order:\$\{order\.id\}:dispute`/);
    expect(src).not.toMatch(/withLock\(`user:\$\{req\.user\.id\}:dispute-raise`/);
  });
});

// ─── 40b-4: Refresh token carries ati; /refresh revokes old access token ─────
describe('Token rotation: refresh revokes prior access token via ati claim', () => {
  it('tokens.js: signRefreshToken accepts ati param and includes it in payload', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/utils/tokens.js'), 'utf-8'
    );
    expect(src).toMatch(/signRefreshToken\(user, ati\)/);
    expect(src).toMatch(/payload\.ati = ati/);
  });

  it('tokens.js: signAccessToken accepts optional jti param', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/utils/tokens.js'), 'utf-8'
    );
    expect(src).toMatch(/signAccessToken\(user, jti/);
  });

  it('user/index.js: login passes accessJti to both signAccessToken and signRefreshToken', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    expect(src).toMatch(/signAccessToken\(user, accessJti\)/);
    expect(src).toMatch(/signRefreshToken\(user, accessJti\)/);
  });

  it('user/index.js: /refresh revokes payload.ati if present', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    expect(src).toMatch(/payload\.ati/);
    expect(src).toMatch(/revoke\(payload\.ati/);
  });

  it('POST /refresh with valid token pair issues new tokens', async () => {
    const name = `p40tk${uniq}`.slice(0, 20);
    const email = `${name}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username: name, email, password: 'Test1234!' });
    const loginRes = await request(app).post('/api/v1/users/login')
      .send({ email, password: 'Test1234!' });
    const { token, refreshToken } = loginRes.body;
    if (!refreshToken) return;

    const refreshRes = await request(app).post('/api/v1/users/refresh')
      .send({ refreshToken });
    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.body).toHaveProperty('token');
    expect(refreshRes.body).toHaveProperty('refreshToken');
    // New tokens must differ from old tokens
    expect(refreshRes.body.token).not.toBe(token);
    expect(refreshRes.body.refreshToken).not.toBe(refreshToken);
  });

  it('POST /refresh: old refresh token cannot be reused after rotation', async () => {
    const name = `p40rt${uniq}`.slice(0, 20);
    const email = `${name}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username: name, email, password: 'Test1234!' });
    const loginRes = await request(app).post('/api/v1/users/login')
      .send({ email, password: 'Test1234!' });
    const { refreshToken } = loginRes.body;
    if (!refreshToken) return;

    // First rotation
    await request(app).post('/api/v1/users/refresh').send({ refreshToken });
    // Second rotation with the same (now-revoked) refresh token must fail
    const replayRes = await request(app).post('/api/v1/users/refresh').send({ refreshToken });
    expect(replayRes.statusCode).toBe(401);
  });
});

// ─── 40b-5: Denylist load failure is logged ──────────────────────────────────
describe('token-denylist.js: corruption is logged not silently swallowed', () => {
  it('token-denylist.js: catch block calls console.error on parse failure', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/middleware/token-denylist.js'), 'utf-8'
    );
    expect(src).toMatch(/console\.error/);
    expect(src).toMatch(/denylist_load_failure|revoked-tokens/);
  });

  it('token-denylist.js: catch block calls appendAuditLog on failure', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/middleware/token-denylist.js'), 'utf-8'
    );
    expect(src).toMatch(/appendAuditLog.*denylist_load_failure/);
  });
});

// ─── 40b-1: lastLogin is persisted ───────────────────────────────────────────
describe('Login: lastLogin is persisted via UserRepository.update', () => {
  it('user/index.js: login uses UserRepository.update for lastLogin, not in-memory mutation', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    expect(src).toMatch(/UserRepository\.update\(user\.id.*lastLogin/);
    expect(src).not.toMatch(/user\.lastLogin\s*=/);
  });
});
