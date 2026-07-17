// tests/security/probe60-permissions-policy.test.js
// Probe 60 (security headers hardening): helmet 7 does not emit a Permissions-Policy
// header. Strawberry's API/SPA uses none of the powerful browser features (camera,
// microphone, geolocation, payment, usb, ...), so we deny them all to shrink the
// attack surface available to any injected/embedded script (least privilege).

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

describe('Permissions-Policy response header', () => {
  it('GET /api/v1/gpus emits a Permissions-Policy header', async () => {
    const res = await request(app).get('/api/v1/gpus');
    expect(res.headers['permissions-policy']).toBeDefined();
  });

  it('denies camera, microphone, geolocation, payment and usb', async () => {
    const res = await request(app).get('/api/v1/gpus');
    const pp = res.headers['permissions-policy'];
    for (const feat of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(pp).toMatch(new RegExp(`${feat}=\\(\\)`));
    }
  });

  it('does not regress existing helmet headers (nosniff, frame-options, HSTS)', async () => {
    const res = await request(app).get('/api/v1/gpus');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect((res.headers['x-frame-options'] || '').toLowerCase()).toBe('sameorigin');
    // helmet 7 enables HSTS by default
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('source: permissionsPolicy middleware is wired in server.js after securityHeaders', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/server.js'), 'utf-8'
    );
    const headersIdx = src.indexOf('app.use(securityHeaders)');
    const ppIdx = src.indexOf('app.use(permissionsPolicy)');
    expect(headersIdx).toBeGreaterThan(-1);
    expect(ppIdx).toBeGreaterThan(headersIdx);
  });
});
