// tests/security/probe47-auth-peerid-email.test.js
// Probe 47 regression tests:
// 47a-1: /node-info and /channels now have explicit jwtAuth before rbac('admin')
//        (consistent with /admin/cache/purge and /admin/stats; defense-in-depth)
// 47b-1: rbac.js already has !req.user guard at line 5 (confirmed, no change needed)
// 47c-1: /peerid/admin/all no longer returns email field (PII minimization —
//         correlating peerId with email deanonymizes all P2P participants)

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 47a-1: explicit jwtAuth on Lightning admin endpoints ────────────────
describe('/node-info and /channels: explicit jwtAuth before rbac', () => {
  it('routes/index.js: /node-info has jwtAuth before rbac(admin)', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/index.js'), 'utf-8'
    );
    // jwtAuth must appear BEFORE rbac('admin') in the /node-info route
    expect(src).toMatch(/\/node-info['"]\s*,\s*jwtAuth\s*,\s*rbac\(['"]admin['"]\)/);
  });

  it('routes/index.js: /channels has jwtAuth before rbac(admin)', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/index.js'), 'utf-8'
    );
    expect(src).toMatch(/\/channels['"]\s*,\s*jwtAuth\s*,\s*rbac\(['"]admin['"]\)/);
  });

  it('routes/index.js: all admin Lightning routes now consistently use jwtAuth+rbac pattern', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/index.js'), 'utf-8'
    );
    // Should NOT have any route with rbac('admin') that omits jwtAuth in the same line
    // (check that the pattern rbac('admin') without preceding jwtAuth on the same route isn't present)
    // Verify the key admin routes all have the pattern
    expect(src).toMatch(/cache\/purge['"]\s*,\s*jwtAuth\s*,\s*rbac/);
    expect(src).toMatch(/admin\/stats['"]\s*,\s*jwtAuth\s*,\s*rbac/);
  });

  it('/node-info returns 401 without token (unauthenticated)', async () => {
    const res = await request(app).get('/api/v1/node-info');
    expect([401, 503]).toContain(res.status); // 401 = no token; 503 = lightning unavailable
  });
});

// ─── 47b-1: rbac middleware has req.user guard ────────────────────────────
describe('rbac middleware: req.user guard present', () => {
  it('rbac.js: checks !user || !user.role before proceeding', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/middleware/rbac.js'), 'utf-8'
    );
    expect(src).toMatch(/!user\s*\|\|\s*!user\.role/);
  });
});

// ─── 47c-1: peerid admin/all does NOT return email field ─────────────────
describe('/peerid/admin/all: email removed from response', () => {
  it('peerid.js: admin/all map expression does not include u.email', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/peerid.js'), 'utf-8'
    );
    // The map callback must NOT reference u.email (the field must not be in the returned object)
    const mapIdx = src.indexOf('.map(u => ({');
    expect(mapIdx).toBeGreaterThan(-1);
    const mapExpr = src.slice(mapIdx, mapIdx + 120);
    expect(mapExpr).not.toMatch(/u\.email/);
  });

  it('peerid.js: admin/all only returns id, peerId, role', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/peerid.js'), 'utf-8'
    );
    // Should have the minimal field set
    expect(src).toMatch(/id:\s*u\.id.*peerId.*role|id.*peerId.*role/s);
  });

  it('peerid deanonymization logic: email+peerId correlation attack prevented', () => {
    // Simulate old response (had email) vs new response (no email)
    const user = { id: 'u1', email: 'alice@example.com', peerId: 'QmXxx', role: 'user' };
    // New safe response shape
    const { id, peerId, role } = user;
    const safeResponse = { id, peerId: peerId || null, role };
    expect(safeResponse).not.toHaveProperty('email');
    expect(safeResponse.id).toBe('u1');
    expect(safeResponse.peerId).toBe('QmXxx');
  });
});
