// tests/security/probe37-stop-log-csp.test.js
// Probe 37 regression tests:
// 37a-1: (removed 2026-09 — the wall-clock elapsedSeconds/measured fallback this
//         guarded only ever fed escrowSvc.settle(), never order.deliveredRatio or
//         the real payout-ledger.js settlement path. It was deleted along with the
//         hold-invoice escrow subsystem. See ARCHITECTURE.md「エスクロー機構の削除」節.
//         deliveredRatioOf() in payout-ledger.js already has its own, independent
//         fallback chain (order.deliveredRatio → usageStats.usageSeconds →
//         assumed_full_completion), unaffected by this removal.)
// 37b-1: resilient-notify.js sanitizes newlines before logging (log injection prevention)
// 37b-4: security.js CSP includes frame-ancestors 'self' (clickjacking prevention)

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// （`src/utils/resilient-notify.js` を検証していたケースは削除。モジュール自体が
//   どこからも require されておらず、到達不能なコードの堅牢性を検証していた。
//   2026-08 のデッドコード掃除でモジュールごと削除。live な通知経路である
//   notifier.js の検証はそのまま残している。）
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
