// tests/scripts/verify-data-consistency.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../../scripts/verify-data-consistency');

function makeDataDir(collections) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdc-'));
  for (const [name, rows] of Object.entries(collections)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(rows));
  }
  return dir;
}

describe('verify-data-consistency', () => {
  let dir;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reports OK on a consistent dataset', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'completed', gpuId: 'g1', providerId: 'u1', completedAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning' }],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'SETTLED' }],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1', pricePerHour: 100 }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues, summary } = run(dir);
    expect(summary.ok).toBe(true);
    expect(issues).toHaveLength(0);
  });

  it('flags escrow referencing a missing order', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [{ id: 'e1', orderId: 'ghost', state: 'HELD' }],
      'verifications.json': [],
    });
    const { issues, summary } = run(dir);
    expect(summary.ok).toBe(false);
    expect(issues.some((i) => i.check === 'dangling-order-ref')).toBe(true);
  });

  it('flags HELD escrow on a cancelled order (stuck funds)', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'cancelled' }],
      'payments.json': [],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'HELD' }],
      'verifications.json': [],
    });
    const { issues, summary } = run(dir);
    expect(summary.ok).toBe(false);
    expect(issues.some((i) => i.check === 'stuck-escrow')).toBe(true);
  });

  it('flags DISPUTED escrow on a terminal order too (DISPUTED also holds funds)', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'completed' }],
      'payments.json': [],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'DISPUTED' }],
      'verifications.json': [],
    });
    const { issues, summary } = run(dir);
    expect(summary.ok).toBe(false);
    expect(issues.some((i) => i.check === 'stuck-escrow')).toBe(true);
  });

  it('warns when escrow is closed (CANCELED/SETTLED) but order is still active', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active' }],
      'payments.json': [],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'CANCELED' }],
      'verifications.json': [],
    });
    const { issues, summary } = run(dir);
    expect(issues.some((i) => i.check === 'closed-escrow-active-order' && i.severity === 'warn')).toBe(true);
    expect(summary.ok).toBe(true);
  });

  it('flags SETTLED escrow on a non-completed order (premature settlement)', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active' }],
      'payments.json': [],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'SETTLED' }],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'premature-settlement')).toBe(true);
  });

  it('flags two open escrows on the same order', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active' }],
      'payments.json': [],
      'escrows.json': [
        { id: 'e1', orderId: 'o1', state: 'HELD' },
        { id: 'e2', orderId: 'o1', state: 'PENDING' },
      ],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'double-open-escrow')).toBe(true);
  });

  it('flags duplicate ids and malformed JSON', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'pending' },
        { id: 'o1', status: 'pending' },
      ],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
    });
    fs.writeFileSync(path.join(dir, 'payments.json'), '{not json');
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'duplicate-id')).toBe(true);
    expect(issues.some((i) => i.check === 'parse')).toBe(true);
  });

  it('flags dangling gpu/user references as warnings (not errors)', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active', gpuId: 'ghost-gpu', providerId: 'ghost-user' }],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues, summary } = run(dir);
    expect(issues.some((i) => i.check === 'dangling-gpu-ref' && i.severity === 'warn')).toBe(true);
    expect(issues.some((i) => i.check === 'dangling-user-ref' && i.severity === 'warn')).toBe(true);
    expect(summary.ok).toBe(true); // warn only, no error
  });

  it('warns on an active/completed order with no payment record', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active' }],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
    });
    const { issues, summary } = run(dir);
    expect(issues.some((i) => i.check === 'missing-payment' && i.severity === 'warn')).toBe(true);
    expect(summary.ok).toBe(true);
  });

  it('warns on unknown payment status', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'pending' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'bizarre' }],
      'escrows.json': [],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'unknown-payment-status' && i.severity === 'warn')).toBe(true);
  });

  it('covers unknown *.json stores: parse error flagged, object-shaped stores allowed', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'pending' }],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
    });
    fs.writeFileSync(path.join(dir, 'watches.json'), '{bad json');
    fs.writeFileSync(path.join(dir, 'revoked-tokens.json'), JSON.stringify({ jti1: Date.now() + 3_600_000 }));
    fs.writeFileSync(path.join(dir, 'reputations.json'), JSON.stringify([{ id: 'r1' }, { id: 'r1' }]));
    const { issues, summary } = run(dir);
    expect(issues.some((i) => i.check === 'parse' && i.detail.includes('watches.json'))).toBe(true);
    expect(issues.some((i) => i.check === 'duplicate-id' && i.detail.includes('reputations.json'))).toBe(true);
    expect(issues.some((i) => i.detail.includes('revoked-tokens.json'))).toBe(false);
    expect(summary.ok).toBe(false);
  });

  it('warns on an open escrow past its deadlineAt', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'matched' }],
      'payments.json': [{ id: 'p1', orderId: 'o1' }],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'HELD', deadlineAt: '2020-01-01T00:00:00Z' }],
      'verifications.json': [],
    });
    const { issues, summary } = run(dir);
    expect(issues.some((i) => i.check === 'expired-open-escrow' && i.severity === 'warn')).toBe(true);
    expect(summary.ok).toBe(true);
  });

  it('warns on duplicate emails across users (case-insensitive)', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'users.json': [
        { id: 'u1', email: 'a@x.com' },
        { id: 'u2', email: 'A@x.com' },
      ],
    });
    const { issues, summary } = run(dir);
    expect(issues.some((i) => i.check === 'duplicate-email' && i.severity === 'warn')).toBe(true);
    expect(summary.ok).toBe(true);
  });

  it('warns on a completed order whose payments never reached paid', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'completed' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'failed' }],
      'escrows.json': [],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'unpaid-completed-order' && i.severity === 'warn')).toBe(true);
  });

  it('checks verification↔escrow consistency: dangling ref error, verdict mismatches warn', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'completed' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning' }],
      'escrows.json': [
        { id: 'e1', orderId: 'o1', state: 'SETTLED' },
        { id: 'e2', orderId: 'o1', state: 'CANCELED' },
      ],
      'verifications.json': [
        { id: 'v1', jobId: 'j1', escrowId: 'ghost', verdict: 'verified' },
        { id: 'v2', jobId: 'j2', escrowId: 'e1', verdict: 'pending' },
        { id: 'v3', jobId: 'j3', escrowId: 'e1', verdict: 'failed' },
        { id: 'v4', jobId: 'j4', escrowId: 'e2', verdict: 'verified' },
      ],
    });
    const { issues, summary } = run(dir);
    expect(summary.ok).toBe(false);
    expect(issues.some((i) => i.check === 'dangling-escrow-ref' && i.severity === 'error')).toBe(true);
    expect(issues.some((i) => i.check === 'stuck-verdict')).toBe(true);
    expect(issues.filter((i) => i.check === 'verdict-escrow-mismatch')).toHaveLength(2);
  });

  it('flags double-booked GPU: overlapping BLOCKING orders on one gpu', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'active', gpuId: 'g1', createdAt: '2026-01-01T00:00:00Z', durationMinutes: 60 },
        { id: 'o2', status: 'pending', gpuId: 'g1', scheduledStartAt: '2026-01-01T00:30:00Z', durationMinutes: 60 },
        { id: 'o3', status: 'pending', gpuId: 'g1', scheduledStartAt: '2026-01-01T05:00:00Z', durationMinutes: 60 },
      ],
      'payments.json': [
        { id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning' },
        { id: 'p2', orderId: 'o2', status: 'pending' },
        { id: 'p3', orderId: 'o3', status: 'pending' },
      ],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues, summary } = run(dir);
    expect(summary.ok).toBe(false);
    const db = issues.filter((i) => i.check === 'double-booked-gpu');
    expect(db).toHaveLength(1); // o1×o2 のみ重複、o3 は別時間帯
  });

  it('extends ref checks to extra array stores (reputations orderId/providerId)', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'pending' }],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    fs.writeFileSync(path.join(dir, 'reputations.json'), JSON.stringify([
      { id: 'r1', orderId: 'ghost-order', userId: 'u1' },
      { id: 'r2', providerId: 'ghost-user' },
    ]));
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'dangling-order-ref' && i.detail.includes('reputations.json'))).toBe(true);
    expect(issues.some((i) => i.check === 'dangling-user-ref' && i.detail.includes('reputations.json'))).toBe(true);
  });

  it('flags duplicate paymentHash (same invoice billed twice)', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'pending' }],
      'payments.json': [
        { id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', paymentHash: 'abc123' },
        { id: 'p2', orderId: 'o1', status: 'pending', paymentHash: 'abc123' },
      ],
      'escrows.json': [],
      'verifications.json': [],
    });
    const { issues, summary } = run(dir);
    expect(summary.ok).toBe(false);
    expect(issues.some((i) => i.check === 'duplicate-payment-hash' && i.severity === 'error')).toBe(true);
  });

  it('warns on non-positive/non-finite amounts', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'pending' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'pending', amount: -100 }],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'PENDING', amountSats: 'lots' }],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.filter((i) => i.check === 'invalid-amount' && i.severity === 'warn')).toHaveLength(2);
  });

  it('checks settlement invariants: sum==amountSats, charged<=amountSats, non-negative', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'completed' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning' }],
      'escrows.json': [
        { id: 'e1', orderId: 'o1', state: 'SETTLED', amountSats: 1000, settlement: { providerPayoutSats: 900, renterRefundSats: 50, operatorFeeSats: 50, chargedSats: 950 } },
        { id: 'e2', orderId: 'o1', state: 'SETTLED', amountSats: 1000, settlement: { providerPayoutSats: 900, renterRefundSats: 0, operatorFeeSats: 50, chargedSats: 950 } },
        { id: 'e3', orderId: 'o1', state: 'SETTLED', amountSats: 1000, settlement: { providerPayoutSats: 1200, renterRefundSats: -200, operatorFeeSats: 0, chargedSats: 1200 } },
      ],
      'verifications.json': [],
    });
    const { issues, summary } = run(dir);
    expect(summary.ok).toBe(false);
    expect(issues.some((i) => i.check === 'settlement-mismatch' && i.detail.includes('e2'))).toBe(true);
    expect(issues.some((i) => i.check === 'settlement-invalid' && i.detail.includes('e3'))).toBe(true);
    expect(issues.some((i) => i.check === 'settlement-mismatch' && i.detail.includes('e1'))).toBe(false);
  });

  it('warns on invalid durationMinutes and pricePerHour', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'pending', durationMinutes: 7 },
        { id: 'o2', status: 'pending', durationMinutes: 60 },
      ],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [
        { id: 'g1', providerId: 'u1', pricePerHour: 0 },
        { id: 'g2', providerId: 'u1', pricePerHour: 500 },
      ],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'invalid-duration' && i.detail.includes('o1'))).toBe(true);
    expect(issues.some((i) => i.check === 'invalid-duration' && i.detail.includes('o2'))).toBe(false);
    expect(issues.some((i) => i.check === 'invalid-price' && i.detail.includes('g1'))).toBe(true);
    expect(issues.some((i) => i.check === 'invalid-price' && i.detail.includes('g2'))).toBe(false);
  });

  it('warns on unknown user roles', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'users.json': [
        { id: 'u1', role: 'admin' },
        { id: 'u2', role: 'superuser' },
      ],
    });
    const { issues, summary } = run(dir);
    expect(issues.some((i) => i.check === 'unknown-role' && i.severity === 'warn' && i.detail.includes('u2'))).toBe(true);
    expect(issues.some((i) => i.check === 'unknown-role' && i.detail.includes('u1'))).toBe(false);
    expect(summary.ok).toBe(true);
  });

  it('warns on providerless GPU and out-of-range review rating', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'completed', userId: 'u1', providerId: 'u1', renterReview: { rating: 3 }, providerReview: { rating: 7 } },
      ],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning' }],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [
        { id: 'g1', providerId: 'u1' },
        { id: 'g2' },
      ],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'missing-provider' && i.detail.includes('g2'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-provider' && i.detail.includes('g1'))).toBe(false);
    expect(issues.some((i) => i.check === 'invalid-rating' && i.detail.includes('providerReview'))).toBe(true);
    expect(issues.some((i) => i.check === 'invalid-rating' && i.detail.includes('renterReview'))).toBe(false);
  });

  it('warns on paid payment with no method and on unknown verdict', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'completed' }],
      'payments.json': [
        { id: 'p1', orderId: 'o1', status: 'paid' },
        { id: 'p2', orderId: 'o1', status: 'pending' },
      ],
      'escrows.json': [],
      'verifications.json': [
        { id: 'v1', jobId: 'j1', verdict: 'verified' },
        { id: 'v2', jobId: 'j2', verdict: 'maybe' },
      ],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'missing-method' && i.detail.includes('p1'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-method' && i.detail.includes('p2'))).toBe(false);
    expect(issues.some((i) => i.check === 'unknown-verdict' && i.detail.includes('v2'))).toBe(true);
    expect(issues.some((i) => i.check === 'unknown-verdict' && i.detail.includes('v1'))).toBe(false);
  });

  it('errors on malformed payout address and warns on empty store', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'profit-addresses.json': ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'not-an-address'],
    });
    let { issues } = run(dir);
    expect(issues.some((i) => i.severity === 'error' && i.check === 'invalid-payout-address' && i.detail.includes('not-an-address'))).toBe(true);
    expect(issues.some((i) => i.check === 'invalid-payout-address' && i.detail.includes('bc1q'))).toBe(false);
    expect(issues.some((i) => i.check === 'no-payout-address')).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'profit-addresses.json': [],
    });
    ({ issues } = run(dir));
    expect(issues.some((i) => i.severity === 'warn' && i.check === 'no-payout-address')).toBe(true);
  });

  it('errors on non-numeric denylist entries and warns on stale revocations', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'revoked-tokens.json': {
        'jti-live': Date.now() + 60 * 60 * 1000,
        'jti-bad': 'garbage',
        'jti-old': Date.now() - 60 * 60 * 1000,
      },
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.severity === 'error' && i.check === 'invalid-denylist-entry' && i.detail.includes('jti-bad'))).toBe(true);
    expect(issues.some((i) => i.check === 'stale-revoked-token' && i.detail.includes('jti-old'))).toBe(true);
    expect(issues.some((i) => i.detail.includes('jti-live'))).toBe(false);
  });

  it('warns on orphan and malformed notification settings', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
      'notification-settings.json': {
        u1: { enabled: { slack: true } },
        ghost: { enabled: { line: true } },
        broken: 'not-an-object',
      },
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'orphan-notification-settings' && i.detail.includes('ghost'))).toBe(true);
    expect(issues.some((i) => i.check === 'orphan-notification-settings' && i.detail.includes('u1'))).toBe(false);
    expect(issues.some((i) => i.check === 'invalid-notification-settings' && i.detail.includes('broken'))).toBe(true);
  });

  it('warns on non-boolean gpu availability flags', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [
        { id: 'g1', providerId: 'u1', pricePerHour: 100, available: true },
        { id: 'g2', providerId: 'u1', pricePerHour: 100, available: 'no' },
        { id: 'g3', providerId: 'u1', pricePerHour: 100 },
      ],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'invalid-availability' && i.detail.includes('g2'))).toBe(true);
    expect(issues.some((i) => i.check === 'invalid-availability' && i.detail.includes('g1'))).toBe(false);
    expect(issues.some((i) => i.check === 'invalid-availability' && i.detail.includes('g3'))).toBe(false);
  });

  it('warns on pending orders long past their scheduled start', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'pending', scheduledStartAt: '2020-01-01T00:00:00Z' },
        { id: 'o2', status: 'pending', scheduledStartAt: new Date(Date.now() + 86_400_000).toISOString() },
        { id: 'o3', status: 'completed', scheduledStartAt: '2020-01-01T00:00:00Z' },
      ],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'stuck-pending-reservation' && i.detail.includes('o1'))).toBe(true);
    expect(issues.some((i) => i.check === 'stuck-pending-reservation' && i.detail.includes('o2'))).toBe(false);
    expect(issues.some((i) => i.check === 'stuck-pending-reservation' && i.detail.includes('o3'))).toBe(false);
  });

  it('warns on GPU records missing pricePerHour', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [
        { id: 'g1', providerId: 'u1', pricePerHour: 100 },
        { id: 'g2', providerId: 'u1' },
      ],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'missing-gpu-price' && i.detail.includes('g2'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-gpu-price' && i.detail.includes('g1'))).toBe(false);
  });

  it('warns on orders missing their status timestamp', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'completed' },
        { id: 'o2', status: 'cancelled' },
        { id: 'o3', status: 'matched' },
        { id: 'o4', status: 'completed', completedAt: '2025-01-01T00:00:00Z' },
        { id: 'o5', status: 'pending' },
      ],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    for (const id of ['o1', 'o2', 'o3']) {
      expect(issues.some((i) => i.check === 'missing-status-timestamp' && i.detail.includes(id))).toBe(true);
    }
    expect(issues.some((i) => i.check === 'missing-status-timestamp' && i.detail.includes('o4'))).toBe(false);
    expect(issues.some((i) => i.check === 'missing-status-timestamp' && i.detail.includes('o5'))).toBe(false);
  });

  it('warns on order records missing gpuId', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'pending', gpuId: 'g1' },
        { id: 'o2', status: 'pending' },
      ],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'missing-gpu' && i.detail.includes('o2'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-gpu' && i.detail.includes('o1'))).toBe(false);
  });

  it('warns on verification records missing jobId', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [
        { id: 'v1', jobId: 'j1', verdict: 'verified' },
        { id: 'v2', verdict: 'pending' },
      ],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'missing-job-ref' && i.detail.includes('v2'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-job-ref' && i.detail.includes('v1'))).toBe(false);
  });

  it('warns on user records missing email', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'users.json': [
        { id: 'u1', email: 'u1@example.com' },
        { id: 'u2' },
      ],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'missing-email' && i.detail.includes('u2'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-email' && i.detail.includes('u1'))).toBe(false);
  });

  it('warns on expired unpaid invoice', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'pending' }],
      'payments.json': [
        { id: 'p1', orderId: 'o1', status: 'pending', invoiceExpiresAt: '2020-01-01T00:00:00Z' },
        { id: 'p2', orderId: 'o1', status: 'pending', invoiceExpiresAt: '2999-01-01T00:00:00Z' },
      ],
      'escrows.json': [],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'expired-invoice' && i.detail.includes('p1'))).toBe(true);
    expect(issues.some((i) => i.check === 'expired-invoice' && i.detail.includes('p2'))).toBe(false);
  });

  it('warns when a payment is unattributable to any party', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'completed', userId: 'u1' },
        { id: 'o2', status: 'completed' },
      ],
      'payments.json': [
        { id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning' },
        { id: 'p2', orderId: 'o2', status: 'pending' },
      ],
      'escrows.json': [],
      'verifications.json': [],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'missing-payer' && i.detail.includes('p2'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-payer' && i.detail.includes('p1'))).toBe(false);
  });

  it('warns on out-of-range escrow feeRate', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'pending' }],
      'payments.json': [],
      'escrows.json': [
        { id: 'e1', orderId: 'o1', state: 'PENDING', feeRate: 0.05 },
        { id: 'e2', orderId: 'o1', state: 'PENDING', feeRate: 1.5 },
      ],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'invalid-fee-rate' && i.detail.includes('e2'))).toBe(true);
    expect(issues.some((i) => i.check === 'invalid-fee-rate' && i.detail.includes('e1'))).toBe(false);
  });

  it('warns on escrow/payment records with no orderId at all', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'pending' }],
      'payments.json': [
        { id: 'p1', orderId: 'o1', status: 'pending' },
        { id: 'p2', status: 'pending' },
      ],
      'escrows.json': [{ id: 'e1', state: 'HELD' }],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'missing-order-ref' && i.detail.includes('p2'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-order-ref' && i.detail.includes('e1'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-order-ref' && i.detail.includes('p1'))).toBe(false);
  });

  it('warns on invalid/future timestamps but tolerates future scheduledStartAt', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'pending', createdAt: 'not-a-date' },
        { id: 'o2', status: 'pending', createdAt: '2999-01-01T00:00:00Z' },
        { id: 'o3', status: 'pending', gpuId: 'g1', scheduledStartAt: '2999-01-01T00:00:00Z' },
      ],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'invalid-timestamp' && i.detail.includes('o1'))).toBe(true);
    expect(issues.some((i) => i.check === 'future-timestamp' && i.detail.includes('o2'))).toBe(true);
    expect(issues.filter((i) => i.detail.includes('o3'))).toHaveLength(0);
  });

  it('warns on open order referencing an unavailable GPU', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'active', gpuId: 'g1', userId: 'u1', providerId: 'u1' },
        { id: 'o2', status: 'completed', gpuId: 'g1', userId: 'u1', providerId: 'u1' },
      ],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning' }, { id: 'p2', orderId: 'o2', status: 'paid', method: 'lightning' }],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1', available: false }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'unavailable-gpu-order' && i.detail.includes('o1'))).toBe(true);
    expect(issues.some((i) => i.check === 'unavailable-gpu-order' && i.detail.includes('o2'))).toBe(false);
  });

  it('warns on refunded-but-progressing order', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'active', userId: 'u1', providerId: 'u1' },
        { id: 'o2', status: 'cancelled', userId: 'u1', providerId: 'u1' },
      ],
      'payments.json': [
        { id: 'p1', orderId: 'o1', status: 'refunded' },
        { id: 'p2', orderId: 'o2', status: 'refunded' },
      ],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'refunded-active-order' && i.detail.includes('o1'))).toBe(true);
    expect(issues.some((i) => i.check === 'refunded-active-order' && i.detail.includes('o2'))).toBe(false);
  });

  it('dispute mismatch is a warning, not an error', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active' }],
      'payments.json': [],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'DISPUTED' }],
      'verifications.json': [],
    });
    const { issues, summary } = run(dir);
    const dispute = issues.find((i) => i.check === 'dispute-mismatch');
    expect(dispute).toBeDefined();
    expect(dispute.severity).toBe('warn');
    expect(summary.ok).toBe(true); // warnings do not fail
  });
});
