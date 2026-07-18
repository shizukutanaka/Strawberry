// Direct unit tests for the auth/RBAC/ownership middleware in
// src/api/middleware/security.js. These functions are the money-app's most
// security-critical code and were only ever exercised incidentally through
// integration tests. Here each branch is driven directly with mock
// req/res/next and real JWTs signed with the process's resolved secret.
const jwt = require('jsonwebtoken');
const {
  authenticateJWT,
  checkRole,
  authenticateAPIKey,
  apiKeyAuth,
  allowOwnerOrAdmin,
} = require('../../../src/api/middleware/security');
const { resolveSecret } = require('../../../src/api/middleware/jwt-auth');
const UserRepository = require('../../../src/db/json/UserRepository');

const SECRET = resolveSecret();

function mockRes() {
  return {};
}
// next() captures whatever it was called with (an APIError on failure, nothing on success).
function capture() {
  const calls = [];
  const next = (arg) => calls.push(arg);
  return { next, calls };
}

describe('authenticateJWT', () => {
  it('rejects a request with no Authorization header (401)', () => {
    const { next, calls } = capture();
    authenticateJWT({ headers: {} }, mockRes(), next);
    expect(calls[0].statusCode || calls[0].status).toBe(401);
    expect(calls[0].message).toMatch(/Authentication required/);
  });

  it('rejects a malformed Authorization header (401 Invalid token format)', () => {
    const { next, calls } = capture();
    authenticateJWT({ headers: { authorization: 'Token abc' } }, mockRes(), next);
    expect(calls[0].message).toMatch(/Invalid token format/);
  });

  it('accepts a valid token for an existing active user and sets req.user', () => {
    const u = UserRepository.create({ username: 'authmw', email: 'authmw@example.com', role: 'user', status: 'active' });
    const token = jwt.sign({ id: u.id, role: 'user' }, SECRET, { algorithm: 'HS256' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const { next, calls } = capture();
    authenticateJWT(req, mockRes(), next);
    expect(calls[0]).toBeUndefined(); // next() with no error
    expect(req.user.id).toBe(u.id);
  });

  it('rejects a refresh-type token used as an access token (401)', () => {
    const u = UserRepository.create({ username: 'refmw', email: 'refmw@example.com', role: 'user', status: 'active' });
    const token = jwt.sign({ id: u.id, role: 'user', type: 'refresh' }, SECRET, { algorithm: 'HS256' });
    const { next, calls } = capture();
    authenticateJWT({ headers: { authorization: `Bearer ${token}` } }, mockRes(), next);
    expect(calls[0].statusCode || calls[0].status).toBe(401);
  });

  it('rejects an expired token with a Token expired message', () => {
    const token = jwt.sign({ id: 'x', role: 'user' }, SECRET, { algorithm: 'HS256', expiresIn: -10 });
    const { next, calls } = capture();
    authenticateJWT({ headers: { authorization: `Bearer ${token}` } }, mockRes(), next);
    expect(calls[0].message).toMatch(/Token expired/);
  });

  it('rejects a garbage token (401 Invalid token)', () => {
    const { next, calls } = capture();
    authenticateJWT({ headers: { authorization: 'Bearer not.a.jwt' } }, mockRes(), next);
    expect(calls[0].message).toMatch(/Invalid token/);
  });

  it('rejects a token whose user has been deactivated (401)', () => {
    const u = UserRepository.create({ username: 'deac', email: 'deac@example.com', role: 'user', status: 'deactivated' });
    const token = jwt.sign({ id: u.id, role: 'user' }, SECRET, { algorithm: 'HS256' });
    const { next, calls } = capture();
    authenticateJWT({ headers: { authorization: `Bearer ${token}` } }, mockRes(), next);
    expect(calls[0].statusCode || calls[0].status).toBe(401);
  });
});

describe('checkRole', () => {
  it('401s when there is no authenticated user', () => {
    const { next, calls } = capture();
    checkRole(['admin'])({}, mockRes(), next);
    expect(calls[0].statusCode || calls[0].status).toBe(401);
  });
  it('403s when the user role is not permitted', () => {
    const { next, calls } = capture();
    checkRole(['admin'])({ user: { role: 'user' } }, mockRes(), next);
    expect(calls[0].statusCode || calls[0].status).toBe(403);
  });
  it('passes when the user role is permitted', () => {
    const { next, calls } = capture();
    checkRole(['admin', 'user'])({ user: { role: 'user' } }, mockRes(), next);
    expect(calls[0]).toBeUndefined();
  });
});

describe('authenticateAPIKey / apiKeyAuth', () => {
  const OLD = process.env.API_KEY;
  afterEach(() => { if (OLD === undefined) delete process.env.API_KEY; else process.env.API_KEY = OLD; });

  it('authenticateAPIKey 401s when no key is provided', () => {
    const { next, calls } = capture();
    authenticateAPIKey({ headers: {} }, mockRes(), next);
    expect(calls[0].statusCode || calls[0].status).toBe(401);
  });
  it('authenticateAPIKey accepts a matching key and sets req.apiClient', () => {
    process.env.API_KEY = 'secret-machine-key';
    const req = { headers: { 'x-api-key': 'secret-machine-key' } };
    const { next, calls } = capture();
    authenticateAPIKey(req, mockRes(), next);
    expect(calls[0]).toBeUndefined();
    expect(req.apiClient.role).toBe('system');
  });
  it('authenticateAPIKey 401s on a mismatched key', () => {
    process.env.API_KEY = 'right';
    const { next, calls } = capture();
    authenticateAPIKey({ headers: { 'x-api-key': 'wrong' } }, mockRes(), next);
    expect(calls[0].statusCode || calls[0].status).toBe(401);
  });
  it('apiKeyAuth passes through (no error) when no key is provided', () => {
    const { next, calls } = capture();
    apiKeyAuth({ headers: {} }, mockRes(), next);
    expect(calls[0]).toBeUndefined();
  });
  it('apiKeyAuth 401s on a mismatched key when API_KEY is configured', () => {
    process.env.API_KEY = 'right';
    const { next, calls } = capture();
    apiKeyAuth({ headers: { 'x-api-key': 'wrong' } }, mockRes(), next);
    expect(calls[0].statusCode || calls[0].status).toBe(401);
  });
});

describe('allowOwnerOrAdmin', () => {
  it('404s when the resource does not exist', async () => {
    const { next, calls } = capture();
    await allowOwnerOrAdmin(() => null)({ user: { id: 'u1', role: 'user' } }, mockRes(), next);
    expect(calls[0].statusCode || calls[0].status).toBe(404);
  });
  it('allows the owning user and attaches req.resource', async () => {
    const req = { user: { id: 'owner1', role: 'user' } };
    const { next, calls } = capture();
    await allowOwnerOrAdmin(() => ({ id: 'r', userId: 'owner1' }))(req, mockRes(), next);
    expect(calls[0]).toBeUndefined();
    expect(req.resource.id).toBe('r');
  });
  it('allows an admin regardless of ownership', async () => {
    const req = { user: { id: 'someadmin', role: 'admin' } };
    const { next, calls } = capture();
    await allowOwnerOrAdmin(() => ({ id: 'r', userId: 'other' }))(req, mockRes(), next);
    expect(calls[0]).toBeUndefined();
  });
  it('403s a non-owner non-admin', async () => {
    const req = { user: { id: 'stranger', role: 'user' } };
    const { next, calls } = capture();
    await allowOwnerOrAdmin(() => ({ id: 'r', userId: 'owner1', providerId: 'prov1' }))(req, mockRes(), next);
    expect(calls[0].statusCode || calls[0].status).toBe(403);
  });
  it('forwards errors thrown by the resource getter to next()', async () => {
    const { next, calls } = capture();
    await allowOwnerOrAdmin(() => { throw new Error('db down'); })({ user: { id: 'u', role: 'user' } }, mockRes(), next);
    expect(calls[0]).toBeInstanceOf(Error);
    expect(calls[0].message).toBe('db down');
  });
});
