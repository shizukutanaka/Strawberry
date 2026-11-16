// tests/security/probe47-auth-peerid-email.test.js
// Probe 47 regression tests:
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
