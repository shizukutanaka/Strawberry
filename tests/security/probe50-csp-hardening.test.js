// tests/security/probe50-csp-hardening.test.js
// Probe 50 regression tests (Qiita/Zenn CSP best-practice review):
// 50a: CSP adds object-src 'none' (block legacy plugin/<object>/<embed> script exec)
// 50b: CSP adds base-uri 'self' (block <base href> hijack of all relative URLs)
// 50c: CSP adds form-action 'self' (block injected <form> exfiltrating to other origins)
// These are standard OWASP CSP hardening directives that complement the existing
// script-src 'self' / frame-ancestors 'self' policy.

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

describe('security.js: CSP hardening directives present in source', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../src/api/middleware/security.js'), 'utf-8'
  );

  it("CSP includes object-src 'none'", () => {
    expect(src).toMatch(/objectSrc:\s*\["'none'"\]/);
  });

  it("CSP includes base-uri 'self'", () => {
    expect(src).toMatch(/baseUri:\s*\["'self'"\]/);
  });

  it("CSP includes form-action 'self'", () => {
    expect(src).toMatch(/formAction:\s*\["'self'"\]/);
  });
});

describe('Content-Security-Policy response header reflects hardening', () => {
  it('GET /api/v1/gpus emits a CSP header with object-src/base-uri/form-action', async () => {
    const res = await request(app).get('/api/v1/gpus');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    // Helmet serializes camelCase directives to kebab-case in the header value
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
    expect(csp).toMatch(/form-action 'self'/);
  });

  it('CSP still keeps script-src self and frame-ancestors self (no regression)', async () => {
    const res = await request(app).get('/api/v1/gpus');
    const csp = res.headers['content-security-policy'];
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).toMatch(/frame-ancestors 'self'/);
  });
});
