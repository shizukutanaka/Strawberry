// tests/security/probe55-request-id-correlation.test.js
// Probe 55 (Qiita/Zenn request-id / traceability review):
// The requestId middleware now (a) reuses a safe inbound X-Request-Id for cross-service
// trace continuity, (b) rejects malformed/oversized inbound values (log/header-injection
// safe) and falls back to a fresh UUID, (c) echoes the id in the X-Request-Id response
// header, and (d) the error handler logs requestId so error logs correlate with the
// morgan access-log line.

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('requestId middleware: X-Request-Id response header', () => {
  it('generates a UUID and returns it in X-Request-Id when none supplied', async () => {
    const res = await request(app).get('/api/v1/gpus');
    const id = res.headers['x-request-id'];
    expect(id).toBeDefined();
    expect(id).toMatch(UUID_V4);
  });

  it('reuses a safe inbound X-Request-Id (cross-service trace continuity)', async () => {
    const supplied = 'gw-abc_123.456-DEF';
    const res = await request(app).get('/api/v1/gpus').set('X-Request-Id', supplied);
    expect(res.headers['x-request-id']).toBe(supplied);
  });

  it('rejects an inbound id with unsafe characters → fresh UUID', async () => {
    const res = await request(app).get('/api/v1/gpus').set('X-Request-Id', 'bad value with spaces!');
    const id = res.headers['x-request-id'];
    expect(id).not.toBe('bad value with spaces!');
    expect(id).toMatch(UUID_V4);
  });

  it('rejects an oversized inbound id (>128 chars) → fresh UUID', async () => {
    const huge = 'a'.repeat(200);
    const res = await request(app).get('/api/v1/gpus').set('X-Request-Id', huge);
    const id = res.headers['x-request-id'];
    expect(id).not.toBe(huge);
    expect(id).toMatch(UUID_V4);
  });
});

describe('requestId / error correlation: source wiring', () => {
  it('logger.js: requestId honors a length+charset-bounded inbound header', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/middleware/logger.js'), 'utf-8'
    );
    expect(src).toMatch(/x-request-id/);
    expect(src).toMatch(/\^\[A-Za-z0-9\._-\]\{1,128\}\$/);
    expect(src).toMatch(/res\.setHeader\(['"]X-Request-Id['"]/);
  });

  it('error-handler.js: error/warn logs include requestId for correlation', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/error-handler.js'), 'utf-8'
    );
    const count = (src.match(/requestId:\s*req\.id/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2); // both the 5xx and the <5xx branch
  });
});
