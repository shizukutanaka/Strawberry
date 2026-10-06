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
      'orders.json': [{ id: 'o1', status: 'completed', gpuId: 'g1', providerId: 'u1' }],
      'payments.json': [{ id: 'p1', orderId: 'o1', status: 'paid' }],
      'escrows.json': [{ id: 'e1', orderId: 'o1', state: 'SETTLED' }],
      'verifications.json': [],
      'gpus.json': [{ id: 'g1', providerId: 'u1' }],
      'users.json': [{ id: 'u1' }],
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
      'users.json': [{ id: 'u1' }],
    });
    const { issues, summary } = run(dir);
    expect(issues.some((i) => i.check === 'dangling-gpu-ref' && i.severity === 'warn')).toBe(true);
    expect(issues.some((i) => i.check === 'dangling-user-ref' && i.severity === 'warn')).toBe(true);
    expect(summary.ok).toBe(true); // warn only, no error
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
