// tests/security/probe39-sanitize-stats.test.js
// Probe 39 regression tests:
// 39a: sanitizeString strips null bytes and C0 control characters
// 39b: GET /marketplace/stats does not expose per-GPU totalSats revenue

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 39a: sanitizeString control character stripping ─────────────────────────
describe('sanitizeString: null bytes and C0 control characters are stripped', () => {
  let sanitizeString;
  beforeAll(() => {
    sanitizeString = require('../../src/utils/sanitize').sanitizeString;
  });

  it('strips null bytes', () => {
    const NUL = String.fromCharCode(0);
    const withNull = 'hel' + NUL + 'lo';
    expect(sanitizeString(withNull)).toBe('hello');
    expect(sanitizeString(withNull)).not.toContain(NUL);
  });

  it('strips C0 control characters (0x01 through 0x1f)', () => {
    const withCtrl = 'hel' + String.fromCharCode(1) + String.fromCharCode(10) + String.fromCharCode(31) + 'lo';
    const result = sanitizeString(withCtrl);
    for (let code = 0; code < 32; code++) {
      expect(result).not.toContain(String.fromCharCode(code));
    }
  });

  it('preserves normal printable strings including spaces and hyphens', () => {
    expect(sanitizeString('RTX 3090 GPU')).toBe('RTX 3090 GPU');
    expect(sanitizeString('price-to-rent')).toBe('price-to-rent');
    expect(sanitizeString('hello world!')).toBe('hello world!');
  });

  it('strips HTML tags and residual angle brackets', () => {
    expect(sanitizeString('<script>alert(1)</script>')).toBe('alert(1)');
    expect(sanitizeString('<<tag>')).not.toMatch(/[<>]/);
  });

  it('null byte before tag opener does not bypass HTML stripping', () => {
    const NUL = String.fromCharCode(0);
    const payload = NUL + '<script>xss</script>';
    const result = sanitizeString(payload);
    expect(result).not.toContain(NUL);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('</script>');
  });
});

// ─── 39b: /marketplace/stats does not leak financial data ────────────────────
describe('GET /marketplace/stats: totalSats not exposed without auth', () => {
  it('source: topGpus map does not spread s (totalSats included) onto result', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/marketplace.js'), 'utf-8'
    );
    const mapIdx = src.indexOf('topGpus = Object.entries(gpuStats)');
    expect(mapIdx).toBeGreaterThan(-1);
    const mapBlock = src.slice(mapIdx, mapIdx + 400);
    expect(mapBlock).not.toMatch(/\.\.\.(s|gpuStats)\b/);
    expect(mapBlock).not.toMatch(/totalSats/);
  });

  it('GET /marketplace/stats returns 200 without auth', async () => {
    const res = await request(app).get('/api/v1/marketplace/stats');
    expect(res.statusCode).toBe(200);
  });

  it('GET /marketplace/stats topGpusByCompletedOrders entries have no totalSats', async () => {
    const res = await request(app).get('/api/v1/marketplace/stats');
    expect(res.statusCode).toBe(200);
    const tops = res.body.topGpusByCompletedOrders || [];
    for (const entry of tops) {
      expect(entry).not.toHaveProperty('totalSats');
    }
  });

  it('GET /marketplace/stats response includes expected public fields', async () => {
    const res = await request(app).get('/api/v1/marketplace/stats');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('totalGpus');
    expect(res.body).toHaveProperty('availableGpus');
    expect(res.body).toHaveProperty('pricing');
    expect(res.body).toHaveProperty('vendorDistribution');
    expect(res.body).toHaveProperty('topGpusByCompletedOrders');
  });
});
