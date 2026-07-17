// tests/security/probe54-notification-enabled-keys.test.js
// Probe 54 regression tests (Qiita/Zenn arbitrary-key / prototype-pollution review):
// The notification-settings `enabled` object previously used Joi.object().pattern(/.*/,
// Joi.boolean()), accepting ARBITRARY keys (incl. __proto__/constructor) as long as the
// value was boolean, and persisting them to notification-settings.json — a store path
// that bypasses the repository-layer stripDangerousKeys guard (probe53). The schema is
// now restricted to the 6 channel keys actually consumed by resolveChannels(); Joi's
// default unknown:false rejects everything else with 400.

const request = require('supertest');
const { app } = require('../../src/api/server');

let token, userId;

beforeAll(async () => {
  const email = `notif54_${Date.now()}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: `notif54${Date.now().toString().slice(-7)}`, email, password: 'Aa1!aaaa' });
  const login = await request(app).post('/api/v1/users/login').send({ email, password: 'Aa1!aaaa' });
  token = login.body.token;
  const me = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
  userId = me.body.user ? me.body.user.id : me.body.id;
});

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

describe('notification-settings: enabled restricted to known channel keys', () => {
  it('source: enabled schema lists explicit channel keys, not pattern(/.*/)', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/notification-settings.js'), 'utf-8'
    );
    expect(src).not.toMatch(/enabled:\s*Joi\.object\(\)\.pattern\(\/\.\*\//);
    expect(src).toMatch(/enabled:\s*Joi\.object\(\{[\s\S]*?line:\s*Joi\.boolean\(\)/);
  });

  it('accepts a valid channel toggle (email)', async () => {
    const res = await request(app)
      .post(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'a@example.com', enabled: { email: true, discord: false } });
    expect(res.statusCode).toBe(200);
  });

  it('strips __proto__ from enabled (Joi drops it; no pollution, not persisted)', async () => {
    // Joi treats __proto__ specially and silently strips it (value becomes enabled:{}),
    // so the request succeeds (200) but the dangerous key is never stored and the
    // prototype is not polluted — the secure outcome.
    const res = await request(app)
      .post(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(JSON.parse('{"enabled":{"__proto__":true}}'));
    expect(res.statusCode).toBe(200);
    expect({}.polluted).toBeUndefined();
    // Read back: enabled must not carry a dangerous own key
    const get = await request(app)
      .get(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${token}`);
    const enabled = get.body.enabled || {};
    expect(Object.prototype.hasOwnProperty.call(enabled, '__proto__')).toBe(false);
  });

  it('rejects an arbitrary enabled key (constructor) with 400', async () => {
    const res = await request(app)
      .post(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(JSON.parse('{"enabled":{"constructor":true}}'));
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unrelated arbitrary key (order_matched) with 400', async () => {
    const res = await request(app)
      .post(`/api/v1/notification-settings/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: { order_matched: true } });
    expect(res.statusCode).toBe(400);
  });
});
