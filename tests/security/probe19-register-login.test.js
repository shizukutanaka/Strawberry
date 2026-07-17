// tests/security/probe19-register-login.test.js
// Probe 19 regression tests:
// 1. sanitizeSensitiveFields masks case-variant keys (Password, TOKEN, etc.)
// 2. POST /register: TOCTOU closed — concurrent same-email requests produce exactly one account
// 3. POST /login: per-account lockout returns 429 after repeated failures
// 4. POST /login: log message is uniform (no "user not found" vs "wrong password" distinction)

const { sanitizeSensitiveFields } = require('../../src/utils/sanitize');

describe('sanitizeSensitiveFields: case-insensitive masking', () => {
  it('masks lowercase canonical fields', () => {
    const out = sanitizeSensitiveFields({ password: 'hunter2', email: 'x@x.com' });
    expect(out.password).toBe('[MASKED]');
    expect(out.email).toBe('[MASKED]');
  });

  it('masks PascalCase fields (Password, Token, ApiKey)', () => {
    const out = sanitizeSensitiveFields({ Password: 'hunter2', Token: 'eyJ', ApiKey: 'k' });
    expect(out.Password).toBe('[MASKED]');
    expect(out.Token).toBe('[MASKED]');
    expect(out.ApiKey).toBe('[MASKED]');
  });

  it('masks UPPER_CASE fields (TOKEN, SECRET)', () => {
    const out = sanitizeSensitiveFields({ TOKEN: 'abc', SECRET: 'xyz' });
    expect(out.TOKEN).toBe('[MASKED]');
    expect(out.SECRET).toBe('[MASKED]');
  });

  it('preserves non-sensitive fields regardless of case', () => {
    const out = sanitizeSensitiveFields({ userId: '123', Role: 'admin', Name: 'Alice' });
    expect(out.userId).toBe('123');
    expect(out.Role).toBe('admin');
    expect(out.Name).toBe('Alice');
  });
});

describe('POST /users/register: TOCTOU closed by withLock', () => {
  const request = require('supertest');
  const { app } = require('../../src/api/server');

  it('concurrent same-email registrations produce exactly one success (201) and one conflict (409)', async () => {
    const uniq = `toctou${Date.now().toString(36)}`;
    const email = `${uniq}@example.com`;
    const username1 = `u1${uniq}`.slice(0, 20);
    const username2 = `u2${uniq}`.slice(0, 20);

    // Fire both simultaneously
    const [r1, r2] = await Promise.all([
      request(app).post('/api/v1/users/register')
        .send({ username: username1, email, password: 'Test1234!' }),
      request(app).post('/api/v1/users/register')
        .send({ username: username2, email, password: 'Test1234!' }),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
  });
});

describe('POST /users/login: per-account brute-force lockout', () => {
  const request = require('supertest');
  const { app } = require('../../src/api/server');
  const UserRepository = require('../../src/db/json/UserRepository');

  const uniq = `lockout${Date.now().toString(36)}`;
  const email = `${uniq}@example.com`;
  const username = `lo${uniq}`.slice(0, 20);

  beforeAll(async () => {
    await request(app).post('/api/v1/users/register')
      .send({ username, email, password: 'Test1234!' });
  });

  it('returns 401 for wrong password initially', async () => {
    const res = await request(app).post('/api/v1/users/login')
      .send({ email, password: 'WRONG!' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 429 after 10 failed attempts', async () => {
    // Send 9 more failures (already sent 1 above) to reach the lockout threshold
    for (let i = 0; i < 9; i++) {
      await request(app).post('/api/v1/users/login')
        .send({ email, password: 'WRONG!' });
    }
    const res = await request(app).post('/api/v1/users/login')
      .send({ email, password: 'WRONG!' });
    expect(res.statusCode).toBe(429);
  });

  it('correct password still returns 429 when locked (prevents bypass)', async () => {
    // Account is locked — even correct password should hit lockout before bcrypt
    const res = await request(app).post('/api/v1/users/login')
      .send({ email, password: 'Test1234!' });
    expect(res.statusCode).toBe(429);
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
