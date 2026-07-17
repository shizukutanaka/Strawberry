// Email case-normalization tests.
// RFC 5321 local-part is technically case-sensitive but virtually every provider
// treats addresses as case-insensitive. Without normalization USER@X.COM and
// user@x.com register as two separate accounts pointing to the same inbox,
// enabling account confusion and duplicate-account exploits.
const request = require('supertest');
const { app } = require('../../src/api/server');

describe('email case normalization', () => {
  const base = `emailcase${Date.now().toString(36)}`.slice(0, 18);
  const lowerEmail = `${base}@example.com`;
  const upperEmail = lowerEmail.toUpperCase();
  const mixedEmail = `${base.toUpperCase()}@EXAMPLE.COM`;
  const password = 'Test1234!';
  const username = base.slice(0, 16);

  it('registers successfully with lower-case email', async () => {
    const res = await request(app).post('/api/v1/users/register')
      .send({ username, email: lowerEmail, password });
    expect(res.statusCode).toBe(201);
  });

  it('rejects registration with the same email in upper-case (duplicate)', async () => {
    const res = await request(app).post('/api/v1/users/register')
      .send({ username: `${username}2`, email: upperEmail, password });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already registered/i);
  });

  it('rejects registration with mixed-case variant of the same email', async () => {
    const res = await request(app).post('/api/v1/users/register')
      .send({ username: `${username}3`, email: mixedEmail, password });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already registered/i);
  });

  it('allows login with the upper-case version of a lower-case-registered email', async () => {
    const res = await request(app).post('/api/v1/users/login')
      .send({ email: upperEmail, password });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('allows login with a mixed-case variant of the registered email', async () => {
    const res = await request(app).post('/api/v1/users/login')
      .send({ email: mixedEmail, password });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeTruthy();
  });
});
