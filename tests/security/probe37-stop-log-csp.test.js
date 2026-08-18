// tests/security/probe37-stop-log-csp.test.js
// Probe 37 regression tests:
// 37a-1: /stop uses wall-clock elapsed time as fallback when vgpuManager absent
//         (prevents renter from getting measured=0 by stopping instantly)
// 37b-1: resilient-notify.js sanitizes newlines before logging (log injection prevention)
// 37b-4: security.js CSP includes frame-ancestors 'self' (clickjacking prevention)

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 37a: /stop wall-clock elapsed time fallback ─────────────────────────────
describe('/stop: wall-clock elapsed time is used when usageStats absent', () => {
  it('order/index.js: elapsedSeconds is calculated from order.startedAt before escrow settle', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // Must compute elapsed from startedAt
    expect(src).toMatch(/elapsedSeconds.*startedAt/);
    expect(src).toMatch(/Date\.now\(\).*new Date\(order\.startedAt\)/);
  });

  it('order/index.js: measured falls back to elapsedSeconds/durationMinutes (not 0) when no usageStats', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // The fallback path must use elapsedSeconds, not a bare `: 0`
    expect(src).toMatch(/elapsedSeconds.*durationMinutes/);
    expect(src).toMatch(/elapsedSeconds \/ \(order\.durationMinutes \* 60\)/);
  });

  it('order/index.js: measured is still 0 when durationMinutes is absent', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // Safety valve: if durationMinutes is missing, default to 0 (not divide-by-zero)
    expect(src).toMatch(/order\.durationMinutes[\s\S]{1,100}Math\.max\(0, Math\.min\(1, elapsedSeconds/);
  });
});

// （`src/utils/resilient-notify.js` を検証していたケースは削除。モジュール自体が
//   どこからも require されておらず、到達不能なコードの堅牢性を検証していた。
//   2026-08 のデッドコード掃除でモジュールごと削除。live な通知経路である
//   notifier.js / webhook.js の検証はそのまま残している。）
// ─── 37b-4: CSP frame-ancestors and X-Frame-Options ─────────────────────────
describe('security.js: clickjacking protection', () => {
  it('security.js: CSP includes frame-ancestors directive', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/middleware/security.js'), 'utf-8'
    );
    expect(src).toMatch(/frameAncestors/);
    expect(src).toMatch(/frameAncestors.*'self'/);
  });

  it('security.js: explicit frameguard sameorigin is configured', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/middleware/security.js'), 'utf-8'
    );
    expect(src).toMatch(/frameguard.*sameorigin/i);
  });

  it('GET /api/v1/gpus returns X-Frame-Options: SAMEORIGIN header', async () => {
    const request = require('supertest');
    const { app } = require('../../src/api/server');
    const res = await request(app).get('/api/v1/gpus');
    const xfo = res.headers['x-frame-options'];
    expect(xfo).toBeDefined();
    expect(xfo.toLowerCase()).toBe('sameorigin');
  });
});
