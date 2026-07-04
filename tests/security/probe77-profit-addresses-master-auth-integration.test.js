// tests/security/probe77-profit-addresses-master-auth-integration.test.js
//
// Phase 3 of the feature-gap cleanup plan: integrate the already-implemented,
// already-tested Google OAuth -> TOTP -> email 3-factor master-auth flow
// (src/api/routes/master-auth.js's requireMasterAuth) into an actual protected
// route. Before this change, requireMasterAuth was never imported by any route
// other than master-auth.js's own router — a fully built, fully tested
// authentication system that guarded nothing.
//
// profit-addresses.js (operator payout/profit-receiving address management —
// directly fund-flow-critical: whoever controls these addresses controls where
// platform profits are sent) now requires requireMasterAuth in addition to the
// existing JWT + rbac('admin') gate.
//
// Critical wiring detail: requireMasterAuth checks req.session.masterAuth, and
// express-session's session(...) middleware was previously called separately
// inside master-auth.js's own router — meaning req.session only existed for
// requests routed through /master-auth/*. Naively adding requireMasterAuth to
// profit-addresses.js without also applying the SAME session middleware
// instance (same MemoryStore) would make req.session always undefined there,
// so every request — even from a legitimately master-auth'd operator — would
// be rejected with 403. Fixed by extracting a single shared session
// middleware instance (src/api/middleware/master-session.js) that both routers
// now import and apply, so a session established via /master-auth/* is
// visible to profit-addresses.js's req.session too.

const request = require('supertest');
const { app } = require('../../src/api/server');
const { requireMasterAuth } = require('../../src/api/routes/master-auth');
const UserRepository = require('../../src/db/json/UserRepository');

const uniq = `p77${Date.now().toString(36)}`;

async function registerAdminAndLogin() {
  const u = `padm${uniq}`.slice(0, 28);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register').send({ username: u, email, password: 'Test1234!' });
  const user = UserRepository.getByEmail(email);
  UserRepository.update(user.id, { role: 'admin' });
  const login = await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' });
  return login.body.token;
}

describe('profit-addresses: requireMasterAuth middleware unit behavior', () => {
  it('rejects with 403 when req.session is absent entirely', () => {
    const req = {};
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    requireMasterAuth(req, res, jest.fn());
    expect(res.status).toBeCalledWith(403);
  });

  it('rejects with 403 when req.session exists but masterAuth is not set', () => {
    const req = { session: {} };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    requireMasterAuth(req, res, jest.fn());
    expect(res.status).toBeCalledWith(403);
  });

  it('passes through when req.session.masterAuth is true', () => {
    const req = { session: { masterAuth: true } };
    const next = jest.fn();
    requireMasterAuth(req, {}, next);
    expect(next).toBeCalled();
  });
});

describe('profit-addresses: HTTP route requires master-auth session (JWT+admin alone is not enough)', () => {
  it('GET with a valid admin JWT but no master-auth session still returns 403', async () => {
    const adminToken = await registerAdminAndLogin();
    const res = await request(app).get('/api/profit-addresses')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(403);
  });

  it('POST with a valid admin JWT but no master-auth session still returns 403', async () => {
    const adminToken = await registerAdminAndLogin();
    const res = await request(app).post('/api/profit-addresses')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' });
    expect(res.statusCode).toBe(403);
  });

  it('a request without any JWT is rejected before even reaching the master-auth check', async () => {
    const res = await request(app).get('/api/profit-addresses');
    expect(res.statusCode).toBe(401);
  });
});

describe('profit-addresses.js source: master-auth wiring', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../src/api/routes/profit-addresses.js'), 'utf-8'
  );

  it('imports requireMasterAuth from master-auth.js', () => {
    expect(src).toMatch(/requireMasterAuth\s*}\s*=\s*require\(['"]\.\/master-auth['"]\)/);
  });

  it('imports the shared masterSession middleware (not a fresh session(...) instance)', () => {
    expect(src).toMatch(/masterSession\s*}\s*=\s*require\(['"]\.\.\/middleware\/master-session['"]\)/);
    expect(src).not.toMatch(/require\(['"]express-session['"]\)/);
  });

  it('applies masterSession, jwtAuth, rbac(admin), and requireMasterAuth all before any route handler', () => {
    const firstRoute = Math.min(
      ...['router.get(', 'router.post(', 'router.delete('].map((s) => {
        const i = src.indexOf(s);
        return i === -1 ? Infinity : i;
      })
    );
    for (const guard of ['router.use(masterSession)', 'router.use(jwtAuth)', "router.use(rbac('admin'))", 'router.use(requireMasterAuth)']) {
      const idx = src.indexOf(guard);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeLessThan(firstRoute);
    }
  });
});

describe('master-auth.js source: uses the shared masterSession module', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../src/api/routes/master-auth.js'), 'utf-8'
  );

  it('no longer creates its own inline session(...) instance', () => {
    expect(src).not.toMatch(/require\(['"]express-session['"]\)/);
    expect(src).not.toMatch(/router\.use\(session\(\{/);
  });

  it('imports and uses the shared masterSession middleware', () => {
    expect(src).toMatch(/masterSession\s*}\s*=\s*require\(['"]\.\.\/middleware\/master-session['"]\)/);
    expect(src).toMatch(/router\.use\(masterSession\)/);
  });
});
