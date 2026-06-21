// tests/security/probe51-bcrypt-72-cap.test.js
// Probe 51 regression tests (Qiita/Zenn bcrypt best-practice review):
// 51a: register/newPassword schemas cap password at 72 chars (bcrypt truncates at
//      72 bytes; without a cap, chars 73+ are silently ignored and two passwords
//      sharing the first 72 bytes authenticate identically).
// 51b: login password is intentionally NOT capped (existing long passwords must
//      still authenticate — bcrypt.compare truncates consistently).

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

describe('password schemas: bcrypt 72-byte cap', () => {
  it('validator.js: register password has max(72)', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/validator.js'), 'utf-8'
    );
    // Anchor on the user-register schema (the GPU schema also uses `register:`)
    const idx = src.indexOf('username: Joi.string().alphanum()');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1400);
    expect(block).toMatch(/password:\s*Joi\.string\(\)[\s\S]*?\.max\(72\)/);
  });

  it('user/index.js: newPassword has max(72)', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    const idx = src.indexOf('newPassword: Joi.string()');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/\.max\(72\)/);
  });

  it('validator.js: login password is NOT capped (no max on login password)', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/validator.js'), 'utf-8'
    );
    const idx = src.indexOf('login: Joi.object(');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 200);
    // login password stays `Joi.string().required()` with no .max()
    expect(block).toMatch(/password:\s*Joi\.string\(\)\.required\(\)/);
  });
});

describe('registration rejects passwords longer than 72 chars', () => {
  it('POST /users/register with a 73-char password → 4xx (validation)', async () => {
    // 73 chars, satisfies the complexity rules but exceeds the bcrypt cap
    const longPw = 'Aa1!' + 'a'.repeat(69); // 4 + 69 = 73 chars
    expect(longPw.length).toBe(73);
    const res = await request(app)
      .post('/api/v1/users/register')
      .send({ username: `pw${Date.now().toString().slice(-8)}`, email: `pw${Date.now()}@example.com`, password: longPw });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('POST /users/register with a 72-char password is accepted by the length rule', async () => {
    // Exactly 72 chars — must NOT be rejected for length (may pass or hit other
    // checks, but the length boundary itself is valid)
    const okPw = 'Aa1!' + 'a'.repeat(68); // 72 chars
    expect(okPw.length).toBe(72);
    const res = await request(app)
      .post('/api/v1/users/register')
      .send({ username: `ok${Date.now().toString().slice(-8)}`, email: `ok${Date.now()}@example.com`, password: okPw });
    // Should not be a length-validation failure; a valid 72-char password registers (201)
    // or conflicts (409) on a duplicate, but never a 'at most 72' validation error.
    if (res.statusCode >= 400 && res.statusCode < 500) {
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/at most 72/);
    } else {
      expect(res.statusCode).toBe(201);
    }
  });
});
