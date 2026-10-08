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
      'orders.json': [{ id: 'o1', status: 'completed', gpuId: 'g1', providerId: 'u1', userId: 'u1', completedAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', paidAt: '2025-01-01T00:00:00Z' }],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'SETTLED' }],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1', pricePerHour: 100, model: 'RTX 4090' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com', role: 'admin' }],
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
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', paidAt: '2025-01-01T00:00:00Z' }],
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
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', paidAt: '2025-01-01T00:00:00Z' }],
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
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', paidAt: '2025-01-01T00:00:00Z' }],
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

  it('warns on verified verdict over a cancelled order', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'cancelled', cancelledAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'CANCELED' }],
      'verifications.json': [{ id: 'v1', jobId: 'j1', escrowId: 'e1', verdict: 'verified' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'verified-cancelled-order' && i.detail.includes('v1'))).toBe(true);
  });

  it('warns on out-of-order status chronology', () => {
    dir = makeDataDir({
      'orders.json': [{
        id: 'o1', status: 'completed',
        createdAt: '2025-01-05T00:00:00Z', matchedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-02T00:00:00Z',
      }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', paidAt: '2025-01-10T00:00:00Z', settledAt: '2025-01-09T00:00:00Z' }],
      'escrows.json': [],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.filter((i) => i.check === 'status-chronology').length).toBeGreaterThanOrEqual(2);
  });

  it('warns on fund records predating their order (fund-before-order)', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active', createdAt: '2025-02-01T00:00:00Z' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', createdAt: '2025-01-01T00:00:00Z' }],
      'escrows.json': [{ id: 'e1', orderId: 'o1', status: 'SETTLED', createdAt: '2025-01-15T00:00:00Z' }],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
    });
    const { issues } = run(dir);
    const fbo = issues.filter((i) => i.check === 'fund-before-order');
    expect(fbo.some((i) => i.detail.includes('p1'))).toBe(true);
    expect(fbo.some((i) => i.detail.includes('e1'))).toBe(true);
  });

  it('does not flag fund records created after their order', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active', createdAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', createdAt: '2025-02-01T00:00:00Z' }],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'fund-before-order')).toBe(false);
  });

  it('warns on malformed user emails', () => {
    dir = makeDataDir({
      'users.json': [
        { id: 'u1', email: 'not-an-email', role: 'user' },
        { id: 'u2', email: 'good@example.com', role: 'user' },
      ],
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'invalid-email' && i.detail.includes('u1'))).toBe(true);
    expect(issues.some((i) => i.check === 'invalid-email' && i.detail.includes('u2'))).toBe(false);
  });

  it('warns when payment userId differs from order userId', () => {
    dir = makeDataDir({
      'users.json': [{ id: 'u1', email: 'a@b.com', role: 'user' }, { id: 'u2', email: 'c@d.com', role: 'user' }],
      'orders.json': [{ id: 'o1', status: 'matched', userId: 'u1', matchedAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', userId: 'u2', paidAt: '2025-01-01T00:00:00Z' }],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'payer-order-mismatch' && i.detail.includes('p1'))).toBe(true);
  });

  it('warns when order providerId differs from the gpu providerId', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'completed', gpuId: 'g1', providerId: 'u1', userId: 'u3', completedAt: '2025-01-01T00:00:00Z' }],
      'gpus.json': [{ id: 'g1', providerId: 'u2', pricePerHour: 100, model: 'RTX 4090' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', paidAt: '2025-01-01T00:00:00Z' }],
      'escrows.json': [],
      'verifications.json': [],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }, { id: 'u2', email: 'u2@example.com' }, { id: 'u3', email: 'u3@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'provider-mismatch' && i.detail.includes('o1'))).toBe(true);
  });

  it('warns on non-positive order totalPrice', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'cancelled', cancelledAt: '2025-01-01T00:00:00Z', totalPrice: 0 }],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'invalid-total-price' && i.detail.includes('o1'))).toBe(true);
  });

  it('warns on duplicate and malformed usernames', () => {
    dir = makeDataDir({
      'users.json': [
        { id: 'u1', email: 'a@b.com', username: 'alice' },
        { id: 'u2', email: 'c@d.com', username: 'alice' },
        { id: 'u3', email: 'e@f.com', username: 'no spaces allowed' },
      ],
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'duplicate-username' && i.detail.includes('alice'))).toBe(true);
    expect(issues.some((i) => i.check === 'invalid-username' && i.detail.includes('u3'))).toBe(true);
    expect(issues.some((i) => i.check === 'invalid-username' && i.detail.includes('u1'))).toBe(false);
  });

  it('warns on duplicate apiKey without leaking the key value', () => {
    dir = makeDataDir({
      'users.json': [
        { id: 'u1', email: 'a@b.com', apiKey: 'super-secret-key-1' },
        { id: 'u2', email: 'c@d.com', apiKey: 'super-secret-key-1' },
        { id: 'u3', email: 'e@f.com', apiKey: 'different-key' },
      ],
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
    });
    const { issues } = run(dir);
    const dup = issues.find((i) => i.check === 'duplicate-api-key');
    expect(dup).toBeTruthy();
    // キー値は資格情報のため detail に出さない（id と桁数のみ）
    expect(dup.detail).not.toContain('super-secret-key-1');
    expect(dup.detail).toContain('u2');
    expect(dup.detail).toContain('u1');
  });

  it('warns on duplicate watch and invalid watch targetPrice', () => {
    dir = makeDataDir({
      'watches.json': [
        { id: 'w1', userId: 'u1', gpuId: 'g1', targetPrice: 100 },
        { id: 'w2', userId: 'u1', gpuId: 'g1', targetPrice: -5 },
      ],
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1' }],
      'users.json': [{ id: 'u1', email: 'a@b.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'duplicate-watch' && i.detail.includes('w2'))).toBe(true);
    expect(issues.some((i) => i.check === 'invalid-watch-target' && i.detail.includes('w2'))).toBe(true);
  });

  it('warns on duplicate providerId in reputations', () => {
    dir = makeDataDir({
      'reputations.json': [
        { id: 'r1', providerId: 'p1' },
        { id: 'r2', providerId: 'p1' },
      ],
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'duplicate-provider-reputation' && i.detail.includes('p1'))).toBe(true);
  });

  it('warns on reputation stats outside the scorer contract ranges', () => {
    dir = makeDataDir({
      'reputations.json': [
        // scorer が静黙クランプする範囲外値 — +1 増分約定からのずれ
        { id: 'r1', providerId: 'p1', stats: { completedJobs: -3, failedJobs: 1.5, slashCount: 'x' } },
        { id: 'r2', providerId: 'p2', stats: { slaUptimePct: 250, interruptionRate: 1.7, stake: -1 } },
        { id: 'r3', providerId: 'p3', stats: 'broken' },
        // 健全レコードは警告を出さない（未記録カウンタの省略も約定どおり）
        { id: 'r4', providerId: 'p4', stats: { completedJobs: 10, failedJobs: 2, slaUptimePct: 99.5, interruptionRate: 0.1, stake: 500000, slashCount: 1 } },
        { id: 'r5', providerId: 'p5' }, // stats 欠落は scorer 既定値が効く
      ],
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
    });
    const { issues } = run(dir);
    const stats = issues.filter((i) => i.check === 'reputation-stats-invalid');
    expect(stats.some((i) => i.detail.includes('r1'))).toBe(true);
    expect(stats.filter((i) => i.detail.includes('r2')).length).toBeGreaterThanOrEqual(2);
    expect(stats.some((i) => i.detail.includes('r3'))).toBe(true);
    expect(stats.some((i) => i.detail.includes('r4'))).toBe(false);
    expect(stats.some((i) => i.detail.includes('r5'))).toBe(false);
  });

  it('warns when users exist but no active admin remains', () => {
    dir = makeDataDir({
      'users.json': [
        { id: 'u1', email: 'u1@example.com', role: 'user' },
        { id: 'u2', email: 'u2@example.com', role: 'admin', status: 'deactivated' },
      ],
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'no-active-admin')).toBe(true);
  });

  it('warns on uptime counters violating the beat-started-session invariants', () => {
    dir = makeDataDir({
      'uptime.json': [
        // sessions はビートで開始される — sessions>beats は経路外の破損
        { id: 'u1', providerId: 'p1', beats: 2, sessions: 5, lastBeatAt: '2025-01-01T00:00:00Z' },
        // gapEvents はビートの部分集合
        { id: 'u2', providerId: 'p2', beats: 1, gapEvents: 3, breaches: -1, lastBeatAt: '2025-01-01T00:00:00Z' },
        // beats>0 だが証跡欠落
        { id: 'u3', providerId: 'p3', beats: 9, sessions: 2 },
        // 健全: beats=0 の新規 breach 記録は許容（recordSlaBreach は beats:0 で作成可）
        { id: 'u4', providerId: 'p4', beats: 0, gapEvents: 0, sessions: 0, breaches: 2, lastBreachAt: '2025-01-02T00:00:00Z' },
      ],
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
    });
    const { issues } = run(dir);
    const drift = issues.filter((i) => i.check === 'uptime-counter-drift');
    expect(drift.some((i) => i.detail.includes('u1') && i.detail.includes('sessions'))).toBe(true);
    expect(drift.some((i) => i.detail.includes('u2') && i.detail.includes('gapEvents'))).toBe(true);
    expect(drift.some((i) => i.detail.includes('u3') && i.detail.includes('lastBeatAt'))).toBe(true);
    expect(drift.some((i) => i.detail.includes('u4'))).toBe(false);
    // breaches の非数・負値はカウンタ検査側が捕捉
    expect(issues.some((i) => i.check === 'invalid-uptime-counter' && i.detail.includes('breaches'))).toBe(true);
  });

  it('warns on stored settlements that violate the sum invariants', () => {
    dir = makeDataDir({
      'escrows.json': [
        // payout+refund+fee !== total — 清算額の行方不明
        { id: 'e1', orderId: 'o1', state: 'SETTLED', amountSats: 1000,
          settlement: { providerPayoutSats: 900, renterRefundSats: 0, operatorFeeSats: 50, chargedSats: 950, breakdown: { total: 1000 } } },
        // charged !== payout+fee
        { id: 'e2', orderId: 'o1', state: 'SETTLED', amountSats: 1000,
          settlement: { providerPayoutSats: 900, renterRefundSats: 50, operatorFeeSats: 50, chargedSats: 800, breakdown: { total: 1000 } } },
        // 負値コンポーネント
        { id: 'e3', orderId: 'o1', state: 'SETTLED', amountSats: 1000,
          settlement: { providerPayoutSats: -5, renterRefundSats: 100, operatorFeeSats: 5, chargedSats: 0, breakdown: { total: 1000 } } },
        // 健全: 全和一致
        { id: 'e4', orderId: 'o1', state: 'SETTLED', amountSats: 1000,
          settlement: { providerPayoutSats: 900, renterRefundSats: 50, operatorFeeSats: 50, chargedSats: 950, breakdown: { total: 1000 } } },
      ],
      'orders.json': [{ id: 'o1', status: 'completed', gpuId: 'g1', providerId: 'u1', userId: 'u1', completedAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1', pricePerHour: 100, model: 'RTX 4090' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com', role: 'admin' }],
    });
    const { issues } = run(dir);
    const drift = issues.filter((i) => i.check === 'settlement-sum-drift');
    expect(drift.some((i) => i.detail.includes('e1'))).toBe(true);
    expect(drift.some((i) => i.detail.includes('e2'))).toBe(true);
    expect(drift.some((i) => i.detail.includes('e3'))).toBe(true);
    expect(drift.some((i) => i.detail.includes('e4'))).toBe(false);
  });

  it('warns on unknown and conflicting payment channels', () => {
    dir = makeDataDir({
      'payments.json': [
        { id: 'p1', orderId: 'o1', status: 'paid', method: 'stripe', paidAt: '2025-01-01T00:00:00Z' },
        { id: 'p2', orderId: 'o1', status: 'paid', method: 'lightning', paymentMethod: 'btc_onchain', paidAt: '2025-01-01T00:00:00Z' },
        { id: 'p3', orderId: 'o1', status: 'paid', method: 'manual', paymentMethod: 'manual', paidAt: '2025-01-01T00:00:00Z' },
      ],
      'orders.json': [{ id: 'o1', status: 'completed', gpuId: 'g1', providerId: 'u1', userId: 'u1', completedAt: '2025-01-01T00:00:00Z' }],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1', pricePerHour: 100, model: 'RTX 4090' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com', role: 'admin' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'unknown-payment-method' && i.detail.includes('stripe'))).toBe(true);
    expect(issues.some((i) => i.check === 'conflicting-payment-method' && i.detail.includes('p2'))).toBe(true);
    expect(issues.some((i) => i.check === 'conflicting-payment-method' && i.detail.includes('p3'))).toBe(false);
    expect(issues.some((i) => i.check === 'unknown-payment-method' && i.detail.includes('manual'))).toBe(false);
  });

  it('does not warn about missing admin on an empty user store (pre-seed)', () => {
    dir = makeDataDir({
      'users.json': [],
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'no-active-admin')).toBe(false);
  });

  it('errors on orders with multiple paid payments', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'matched', matchedAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [
        { id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', paidAt: '2025-01-01T00:00:00Z' },
        { id: 'p2', orderId: 'o1', status: 'paid', method: 'btc_onchain', paidAt: '2025-01-02T00:00:00Z' },
        { id: 'p3', orderId: 'o1', status: 'pending' },
      ],
      'escrows.json': [],
      'verifications.json': [],
    });
    const { issues, summary } = run(dir);
    expect(issues.some((i) => i.check === 'double-paid-order' && i.detail.includes('o1'))).toBe(true);
    expect(summary.ok).toBe(false);
  });

  it('warns on malformed escrow history', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'completed', completedAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [],
      'escrows.json': [
        { id: 'e1', orderId: 'o1', state: 'SETTLED', history: [{ event: 'PAY', from: 'PENDING', to: 'HELD' }] },
        { id: 'e2', orderId: 'o1', state: 'CANCELED', history: 'oops' },
        { id: 'e3', orderId: 'o1', state: 'CANCELED', history: [{ from: 'PENDING' }] },
      ],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'malformed-escrow-history' && i.detail.includes('e2'))).toBe(true);
    expect(issues.some((i) => i.check === 'malformed-escrow-history' && i.detail.includes('e3'))).toBe(true);
    expect(issues.some((i) => i.check === 'malformed-escrow-history' && i.detail.includes('e1'))).toBe(false);
  });

  it('warns on orders missing renter attribution', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'pending', userId: 'u1' },
        { id: 'o2', status: 'pending', renterId: 'u1' },
        { id: 'o3', status: 'pending' },
      ],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'missing-renter' && i.detail.includes('o3'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-renter' && i.detail.includes('o1'))).toBe(false);
    expect(issues.some((i) => i.check === 'missing-renter' && i.detail.includes('o2'))).toBe(false);
  });

  it('warns on paid payments missing paidAt', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'matched', matchedAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [
        { id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning' },
        { id: 'p2', orderId: 'o1', status: 'paid', method: 'lightning', paidAt: '2025-01-01T00:00:00Z' },
      ],
      'escrows.json': [],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'missing-paid-timestamp' && i.detail.includes('p1'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-paid-timestamp' && i.detail.includes('p2'))).toBe(false);
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

  it('warns on GPU records missing model', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [
        { id: 'g1', providerId: 'u1', pricePerHour: 100, model: 'RTX 4090' },
        { id: 'g2', providerId: 'u1', pricePerHour: 100 },
      ],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'missing-gpu-model' && i.detail.includes('g2'))).toBe(true);
    expect(issues.some((i) => i.check === 'missing-gpu-model' && i.detail.includes('g1'))).toBe(false);
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
        { id: 'o3', status: 'pending', gpuId: 'g1', userId: 'u1', scheduledStartAt: '2999-01-01T00:00:00Z' },
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

  it('warns on sla counter mismatch (up+down != total)', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
      'sla.json': { total: 10, up: 5, down: 2, history: [] },
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'sla-counter-mismatch')).toBe(true);
  });

  it('accepts consistent sla counters without warning', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
      'sla.json': { total: 7, up: 5, down: 2, history: [{ time: '2026-01-01T00:00:00Z', alive: true }] },
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check && i.check.startsWith('sla-'))).toBe(false);
  });

  it('warns on invalid sla counter and malformed history', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
      'sla.json': { total: -1, up: 0, down: -1, history: [{ bogus: true }] },
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'sla-counter-invalid')).toBe(true);
    expect(issues.some((i) => i.check === 'sla-history-invalid')).toBe(true);
  });

  it('warns on duplicate providerId in uptime.json', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
      'uptime.json': [
        { id: 't1', providerId: 'u1', beats: 10, gapEvents: 0, sessions: 1 },
        { id: 't2', providerId: 'u1', beats: 5, gapEvents: 0, sessions: 1 },
        { id: 't3', providerId: 'u2', beats: 3, gapEvents: 0, sessions: 1 },
      ],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'duplicate-provider-uptime' && i.detail.includes('u1'))).toBe(true);
    expect(issues.some((i) => i.check === 'duplicate-provider-uptime' && i.detail.includes('u2'))).toBe(false);
  });

  it('warns on invalid uptime counters', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
      'uptime.json': [{ id: 't1', providerId: 'u1', beats: -3, gapEvents: 'x' }],
    });
    const { issues } = run(dir);
    const bad = issues.filter((i) => i.check === 'invalid-uptime-counter');
    expect(bad).toHaveLength(2); // beats と gapEvents の2件
  });

  it('warns on durationMinutes above the 30-day Joi ceiling', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'pending', durationMinutes: 50000 }],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'invalid-duration' && i.detail.includes('43200'))).toBe(true);
  });

  it('warns on schedule-window mismatch (end != start + duration)', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'matched', gpuId: 'g1', durationMinutes: 60, scheduledStartAt: '2026-01-01T00:00:00Z', scheduledEndAt: '2026-01-01T02:00:00Z' },
        { id: 'o2', status: 'matched', gpuId: 'g1', durationMinutes: 60, scheduledStartAt: '2026-02-01T00:00:00Z', scheduledEndAt: '2026-02-01T01:00:00Z' },
      ],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'schedule-window-mismatch' && i.detail.includes('o1'))).toBe(true);
    expect(issues.some((i) => i.check === 'schedule-window-mismatch' && i.detail.includes('o2'))).toBe(false);
  });

  it('warns on review attached to a non-completed order', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'active', review: { rating: 5, comment: 'x', reviewedAt: '2026-01-01T00:00:00Z' } },
        { id: 'o2', status: 'completed', review: { rating: 5, comment: 'x', reviewedAt: '2026-01-01T00:00:00Z' } },
      ],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'review-on-unfinished-order' && i.detail.includes('o1'))).toBe(true);
    expect(issues.some((i) => i.check === 'review-on-unfinished-order' && i.detail.includes('o2'))).toBe(false);
  });

  it('warns on out-of-range rating in canonical o.review', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'completed', review: { rating: 7 } }],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'invalid-rating' && i.detail.includes('o1'))).toBe(true);
  });

  it('warns on GPU enum/schema violations (vendor, apiType, memoryGB)', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [
        { id: 'g1', vendor: 'CustomSilicon', apiType: 'CUDA', memoryGB: 24, model: 'X' },
        { id: 'g2', vendor: 'NVIDIA', apiType: 'WebGPU', memoryGB: 24, model: 'X' },
        { id: 'g3', vendor: 'AMD', apiType: 'ROCm', memoryGB: 0, model: 'X' },
        { id: 'g4', vendor: 'Intel', apiType: 'oneAPI', memoryGB: 16, model: 'X' },
      ],
      'users.json': [],
    });
    const { issues } = run(dir);
    expect(issues.filter((i) => i.check === 'invalid-gpu-enum')).toHaveLength(2);
    expect(issues.some((i) => i.check === 'invalid-gpu-memory' && i.detail.includes('g3'))).toBe(true);
    expect(issues.some((i) => i.check === 'invalid-gpu-enum' && i.detail.includes('g4'))).toBe(false);
  });

  it('warns on totalPrice deviating from pricePerHour × durationMinutes / 60', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'completed', pricePerHour: 100, durationMinutes: 60, totalPrice: 500 },
        { id: 'o2', status: 'pending', pricePerHour: 100, durationMinutes: 60, totalPrice: 100 },
        { id: 'o3', status: 'pending', pricePerHour: 0, durationMinutes: 60, totalPrice: 500 },
      ],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'total-price-mismatch' && i.detail.includes('o1'))).toBe(true);
    expect(issues.some((i) => i.check === 'total-price-mismatch' && i.detail.includes('o2'))).toBe(false);
    expect(issues.some((i) => i.check === 'total-price-mismatch' && i.detail.includes('o3'))).toBe(false);
  });

  it('warns on HELD escrow missing release info (stuck funds)', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active' }],
      'payments.json': [],
      'escrows.json': [
        { id: 'e1', orderId: 'o1', state: 'HELD' },
        { id: 'e2', orderId: 'o1', state: 'HELD', preimageHash: 'abc' },
        { id: 'e3', orderId: 'o1', state: 'HELD', txBorrowerToOperator: 'txid1' },
        { id: 'e4', orderId: 'o1', state: 'SETTLED' },
      ],
      'verifications.json': [],
      'gpus.json': [],
      'users.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'held-escrow-unreleasable' && i.detail.includes('e1'))).toBe(true);
    expect(issues.some((i) => i.check === 'held-escrow-unreleasable' && i.detail.includes('e2'))).toBe(false);
    expect(issues.some((i) => i.check === 'held-escrow-unreleasable' && i.detail.includes('e3'))).toBe(false);
    expect(issues.some((i) => i.check === 'held-escrow-unreleasable' && i.detail.includes('e4'))).toBe(false);
  });

  it('warns on out-of-range GPU spec fields (clockMHz, powerWatt, availability)', () => {
    dir = makeDataDir({
      'orders.json': [],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [
        { id: 'g1', clockMHz: 50, model: 'X' },
        { id: 'g2', powerWatt: 0, model: 'X' },
        { id: 'g3', availability: { hoursPerDay: 25, daysAvailable: [0, 7] }, model: 'X' },
        { id: 'g4', clockMHz: 1500, powerWatt: 300, availability: { hoursPerDay: 8, daysAvailable: [0, 6] }, model: 'X' },
      ],
      'users.json': [],
    });
    const { issues } = run(dir);
    expect(issues.filter((i) => i.check === 'invalid-gpu-spec')).toHaveLength(2);
    expect(issues.filter((i) => i.check === 'invalid-gpu-availability')).toHaveLength(2);
    expect(issues.some((i) => i.check === 'invalid-gpu-spec' && i.detail.includes('g4'))).toBe(false);
    expect(issues.some((i) => i.check === 'invalid-gpu-availability' && i.detail.includes('g4'))).toBe(false);
  });
});

  it('warns when a disputed order has a non-DISPUTED escrow (dispute-escrow-mismatch)', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'disputed' }],
      'payments.json': [],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'HELD', preimageHash: 'ph' }],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    const m = issues.find((i) => i.check === 'dispute-escrow-mismatch');
    expect(m).toBeDefined();
    expect(m.severity).toBe('warn');
    expect(m.detail).toContain('e1');
  });

  it('does not flag disputed order when escrow is DISPUTED or absent', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'disputed' },
        { id: 'o2', status: 'disputed' },
      ],
      'payments.json': [],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'DISPUTED' }],
      'verifications.json': [],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'dispute-escrow-mismatch')).toBe(false);
  });

describe('escrow history FSM legality', () => {
  const base = { 'orders.json': [], 'payments.json': [], 'verifications.json': [], 'gpus.json': [], 'users.json': [] };

  it('passes a valid transition chain', () => {
    dir = makeDataDir({
      ...base,
      'escrows.json': [{
        id: 'e1', orderId: 'o1', status: 'SETTLED',
        history: [
          { event: 'PAY', state: 'HELD', at: 't1' },
          { event: 'LN_ACTIONS_EXECUTED', at: 't2' },
          { event: 'DELIVER_OK', state: 'SETTLED', at: 't3' },
        ],
      }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'illegal-escrow-transition')).toBe(false);
    expect(issues.some((i) => i.check === 'escrow-history-state-drift')).toBe(false);
  });

  it('flags an out-of-order FSM event and a state mismatch', () => {
    dir = makeDataDir({
      ...base,
      'escrows.json': [
        // DELIVER_OK は PENDING では無効（HELD でのみ有効）
        { id: 'e1', orderId: 'o1', status: 'HELD', history: [{ event: 'DELIVER_OK', state: 'SETTLED', at: 't1' }] },
        // PAY は HELD へ遷移するが記録 state が SETTLED = 記録改竄
        { id: 'e2', orderId: 'o2', status: 'SETTLED', history: [{ event: 'PAY', state: 'SETTLED', at: 't1' }] },
      ],
    });
    const { issues } = run(dir);
    const ill = issues.filter((i) => i.check === 'illegal-escrow-transition');
    expect(ill.some((i) => i.detail.includes('e1'))).toBe(true);
    expect(ill.some((i) => i.detail.includes('e2'))).toBe(true);
  });

  it('flags history-end vs current-state drift', () => {
    dir = makeDataDir({
      ...base,
      'escrows.json': [{ id: 'e1', orderId: 'o1', status: 'DISPUTED', history: [{ event: 'PAY', state: 'HELD', at: 't1' }] }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'escrow-history-state-drift' && i.detail.includes('e1'))).toBe(true);
  });

  it('warns on paid payment below the order price lock', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active', gpuId: 'g1', providerId: 'u1', userId: 'u1', totalPrice: 1000, createdAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', amount: 400, paidAt: '2025-01-02T00:00:00Z' }],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1', pricePerHour: 100, model: 'RTX 4090' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'payment-undercharge' && i.detail.includes('p1'))).toBe(true);
  });

  it('warns on non-onchain amount drift but tolerates btc_onchain fee-included totals', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active', gpuId: 'g1', providerId: 'u1', userId: 'u1', totalPrice: 1000, createdAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [
        { id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', amount: 1200, paidAt: '2025-01-02T00:00:00Z' },
        { id: 'p2', orderId: 'o1', status: 'paid', method: 'btc_onchain', amount: 1005, paidAt: '2025-01-03T00:00:00Z' },
        { id: 'p3', orderId: 'o1', status: 'paid', method: 'manual', amount: 1000, paidAt: '2025-01-04T00:00:00Z' },
        { id: 'p4', orderId: 'o1', status: 'pending', method: 'lightning', amount: 5 },
      ],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1', pricePerHour: 100, model: 'RTX 4090' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'payment-amount-mismatch' && i.detail.includes('p1'))).toBe(true);
    expect(issues.some((i) => i.check === 'payment-amount-mismatch' && i.detail.includes('p2'))).toBe(false);
    expect(issues.some((i) => i.check === 'payment-amount-mismatch' && i.detail.includes('p3'))).toBe(false);
    expect(issues.some((i) => i.check === 'payment-undercharge' && i.detail.includes('p4'))).toBe(false);
  });

  it('warns on escrow locked below the order price', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active', gpuId: 'g1', providerId: 'u1', userId: 'u1', totalPrice: 1000, createdAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', amount: 1000, paidAt: '2025-01-02T00:00:00Z' }],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'HELD', amountSats: 300 }],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1', pricePerHour: 100, model: 'RTX 4090' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'escrow-undercharge' && i.detail.includes('e1'))).toBe(true);
  });

  it('warns on non-onchain escrow amount drift, tolerates btc_onchain fee-included rows', () => {
    dir = makeDataDir({
      'orders.json': [{ id: 'o1', status: 'active', gpuId: 'g1', providerId: 'u1', userId: 'u1', totalPrice: 1000, createdAt: '2025-01-01T00:00:00Z' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', amount: 1000, paidAt: '2025-01-02T00:00:00Z' }],
      'escrows.json': [
        { id: 'e1', orderId: 'o1', state: 'HELD', amountSats: 1500 },
        { id: 'e2', orderId: 'o1', state: 'HELD', amountSats: 1005, lenderWallet: 'bc1xyz', operatorWallet: 'bc1op', total: 0.001, payout: 0.0009 },
        { id: 'e3', orderId: 'o1', state: 'PENDING', amountSats: 1000 },
      ],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1', pricePerHour: 100, model: 'RTX 4090' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'escrow-amount-mismatch' && i.detail.includes('e1'))).toBe(true);
    expect(issues.some((i) => i.check === 'escrow-amount-mismatch' && i.detail.includes('e2'))).toBe(false);
    expect(issues.some((i) => i.check === 'escrow-amount-mismatch' && i.detail.includes('e3'))).toBe(false);
  });

  it('warns on a corrupted reservation window', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'matched', gpuId: 'g1', providerId: 'u1', userId: 'u1', durationMinutes: 60, scheduledStartAt: '2025-06-01T00:00:00Z', scheduledEndAt: '2025-06-01T00:30:00Z', createdAt: '2025-05-01T00:00:00Z', matchedAt: '2025-05-02T00:00:00Z' },
        { id: 'o2', status: 'matched', gpuId: 'g1', providerId: 'u1', userId: 'u1', durationMinutes: 60, scheduledStartAt: '2025-06-01T00:00:00Z', scheduledEndAt: '2025-06-01T00:00:00Z', createdAt: '2025-05-01T00:00:00Z', matchedAt: '2025-05-02T00:00:00Z' },
        { id: 'o3', status: 'matched', gpuId: 'g1', providerId: 'u1', userId: 'u1', durationMinutes: 60, scheduledStartAt: '2025-06-01T00:00:00Z', scheduledEndAt: '2025-06-01T01:00:00Z', createdAt: '2025-05-01T00:00:00Z', matchedAt: '2025-05-02T00:00:00Z' },
      ],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid', method: 'lightning', paidAt: '2025-05-02T00:00:00Z' }],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1', pricePerHour: 100, model: 'RTX 4090' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    expect(issues.some((i) => i.check === 'schedule-window-mismatch' && i.detail.includes('o1'))).toBe(true);
    expect(issues.some((i) => i.check === 'reversed-schedule' && i.detail.includes('o2'))).toBe(true);
    expect(issues.some((i) => i.check === 'schedule-window-mismatch' && i.detail.includes('o3'))).toBe(false);
  });

  it('warns on slaBreach records missing settlement evidence', () => {
    dir = makeDataDir({
      'orders.json': [
        { id: 'o1', status: 'completed', gpuId: 'g1', providerId: 'u1', userId: 'u1', slaBreach: true, completedAt: '2025-01-02T00:00:00Z', createdAt: '2025-01-01T00:00:00Z', matchedAt: '2025-01-01T01:00:00Z' },
        { id: 'o2', status: 'completed', gpuId: 'g1', providerId: 'u1', userId: 'u1', slaBreach: true, deliveredRatio: 1.5, slaBreachReason: 'provider_heartbeat_lost', completedAt: '2025-01-02T00:00:00Z', createdAt: '2025-01-01T00:00:00Z', matchedAt: '2025-01-01T01:00:00Z' },
        { id: 'o3', status: 'completed', gpuId: 'g1', providerId: 'u1', userId: 'u1', slaBreach: true, deliveredRatio: 0.4, slaBreachReason: 'provider_heartbeat_lost', completedAt: '2025-01-02T00:00:00Z', createdAt: '2025-01-01T00:00:00Z', matchedAt: '2025-01-01T01:00:00Z' },
      ],
      'payments.json': [],
      'escrows.json': [],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1', pricePerHour: 100, model: 'RTX 4090' }],
      'users.json': [{ id: 'u1', email: 'u1@example.com' }],
    });
    const { issues } = run(dir);
    const breach = issues.filter((i) => i.check === 'incomplete-breach-record');
    expect(breach.some((i) => i.detail.includes('o1'))).toBe(true);
    expect(breach.some((i) => i.detail.includes('o2'))).toBe(true);
    expect(breach.some((i) => i.detail.includes('o3'))).toBe(false);
  });
});
