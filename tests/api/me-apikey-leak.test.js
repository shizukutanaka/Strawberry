// Regression: GET /me and PUT /me must never leak the user's apiKey (or password).
// Previously both handlers deleted only `password`, exposing the apiKey in the
// response body — a credential leak. The fix routes all user serialization
// through the shared sanitizeUser() helper.
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const { sanitizeUser } = require('../../src/api/utils/sanitize-user');

async function registerAndLogin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}`.slice(0, 22);
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email: `${u}@example.com`, password: 'Test1234!' });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email: `${u}@example.com`, password: 'Test1234!' });
  const id = login.body.user?.id || UserRepository.getByEmail(`${u}@example.com`).id;
  return { token: login.body.token, id };
}

describe('GET/PUT /me do not leak credentials', () => {
  let me;

  beforeAll(async () => {
    me = await registerAndLogin('leak');
    // Force a known apiKey onto the user record so we can assert it is stripped.
    UserRepository.update(me.id, { apiKey: 'secret-api-key-should-never-leak' });
  });

  it('GET /me strips apiKey and password', async () => {
    const res = await request(app).get('/api/v1/users/me')
      .set('Authorization', `Bearer ${me.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.apiKey).toBeUndefined();
    expect(res.body.password).toBeUndefined();
    expect(res.body.id).toBe(me.id); // still returns the profile
  });

  it('PUT /me strips apiKey and password from the returned user', async () => {
    const res = await request(app).put('/api/v1/users/me')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ username: `leakupd${Date.now().toString(36)}`.slice(0, 20) });
    expect(res.statusCode).toBe(200);
    expect(res.body.user.apiKey).toBeUndefined();
    expect(res.body.user.password).toBeUndefined();
  });

  it('sanitizeUser strips all sensitive fields and preserves the rest', () => {
    const safe = sanitizeUser({
      id: 'x', username: 'bob', email: 'b@x.com',
      password: 'h', apiKey: 'k', twoFactorSecret: 't',
    });
    expect(safe).toEqual({ id: 'x', username: 'bob', email: 'b@x.com' });
  });

  it('sanitizeUser passes through null/non-objects unchanged', () => {
    expect(sanitizeUser(null)).toBeNull();
    expect(sanitizeUser(undefined)).toBeUndefined();
  });
});
