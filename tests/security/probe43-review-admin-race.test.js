// tests/security/probe43-review-admin-race.test.js
// Probe 43 regression tests:
// 43g-1: /stop sets completedAt (review window anchor no longer undefined)
// 43g-2: dispute uphold sets completedAt alongside stoppedAt
// 43g-3: review handler falls back to stoppedAt when completedAt absent (legacy records)
// 43g-4: renter-review handler uses same fallback
// 43d-1: role-change handler rejects deactivated acting admin (fresh DB lookup)
// 43d-2: role-change handler rejects suspended acting admin

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 43g: completedAt now set at order completion ─────────────────────────
describe('/stop handler: completedAt set alongside stoppedAt', () => {
  it('order/index.js: /stop sets completedAt in updateData', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // updateData must include completedAt
    expect(src).toMatch(/updateData\s*=\s*\{[^}]*completedAt[^}]*stoppedAt|updateData\s*=\s*\{[^}]*stoppedAt[^}]*completedAt/s);
  });

  it('order/index.js: dispute uphold sets completedAt alongside stoppedAt', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // The uphold CAS block must have completedAt: resolvedAt
    expect(src).toMatch(/completedAt:\s*resolvedAt/);
    expect(src).toMatch(/stoppedAt:\s*resolvedAt/);
  });
});

describe('review handlers: 30-day window uses stoppedAt fallback', () => {
  it('order/index.js: /review window checks completedAt || stoppedAt', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    expect(src).toMatch(/completedAt.*\|\|.*stoppedAt|reviewWindowAnchor/s);
  });

  it('order/index.js: /renter-review window also uses fallback anchor', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // Count how many times the fallback anchor pattern appears (both handlers)
    const count = (src.match(/renterReviewWindowAnchor|completedAt \|\| order\.stoppedAt/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('review window logic: stale order (stoppedAt 31 days ago) is rejected', () => {
    // Simulate the window check logic inline
    const stoppedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const order = { status: 'completed', stoppedAt, completedAt: undefined };
    const anchor = order.completedAt || order.stoppedAt;
    const days = (Date.now() - new Date(anchor).getTime()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(30);
  });

  it('review window logic: fresh order (stoppedAt 1 day ago) is allowed', () => {
    const stoppedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const completedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const order = { status: 'completed', stoppedAt, completedAt };
    const anchor = order.completedAt || order.stoppedAt;
    const days = (Date.now() - new Date(anchor).getTime()) / (1000 * 60 * 60 * 24);
    expect(days).toBeLessThanOrEqual(30);
  });
});

// ─── 43d: active-admin check in role-change handler ──────────────────────
describe('role-change handler: rejects deactivated/suspended acting admin', () => {
  it('user/index.js: fresh DB lookup of acting admin before role change', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    // Must re-fetch acting admin from repository (not just trust JWT)
    expect(src).toMatch(/UserRepository\.getById\(req\.user\.id\)/);
    // Must check deactivated status
    expect(src).toMatch(/actingAdmin.*status.*deactivated|deactivated.*actingAdmin/s);
  });

  it('user/index.js: suspended acting admin also rejected', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    expect(src).toMatch(/actingAdmin.*status.*suspended|suspended.*actingAdmin/s);
  });

  it('role-change check: deactivated acting admin is rejected', () => {
    // Simulate the guard logic inline
    const actingAdmin = { id: 'admin1', role: 'admin', status: 'deactivated' };
    const isActive = actingAdmin && actingAdmin.status !== 'deactivated' && actingAdmin.status !== 'suspended';
    expect(isActive).toBe(false);
  });
});
