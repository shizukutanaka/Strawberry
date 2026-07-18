// Covers the matched / disputed / active auto-expiry jobs in
// src/utils/order-expiry.js. The existing order-expiry.test.js only exercises
// the pending-payment-timeout path (expireStaleOrders); these three jobs run on
// the same periodic sweep and transition stuck orders so GPUs/funds aren't held
// hostage. Timeouts are forced to 0 and timestamps set well in the past so a
// freshly-created order is immediately "stale".
const OrderRepository = require('../../src/db/json/OrderRepository');
const {
  expireStaleMatchedOrders,
  expireStaleDisputedOrders,
  expireStaleActiveOrders,
} = require('../../src/utils/order-expiry');

const OLD = '2020-01-01T00:00:00.000Z';

afterEach(() => {
  delete process.env.ORDER_MATCHED_TIMEOUT_MINUTES;
  delete process.env.ORDER_DISPUTE_TIMEOUT_DAYS;
  delete process.env.ORDER_ACTIVE_TIMEOUT_HOURS;
  delete process.env.AUTO_DISPUTE_DECISION;
});

describe('expireStaleMatchedOrders', () => {
  it('cancels a matched order past its match timeout', () => {
    process.env.ORDER_MATCHED_TIMEOUT_MINUTES = '0';
    const o = OrderRepository.create({ status: 'matched', matchedAt: OLD, userId: 'u1', durationMinutes: 60 });
    const count = expireStaleMatchedOrders();
    expect(count).toBeGreaterThanOrEqual(1);
    const after = OrderRepository.getById(o.id);
    expect(after.status).toBe('cancelled');
    expect(after.cancelReason).toBe('match_timeout');
  });

  it('leaves a freshly-matched order alone under the default timeout', () => {
    const o = OrderRepository.create({ status: 'matched', matchedAt: new Date().toISOString(), userId: 'u1' });
    expireStaleMatchedOrders();
    expect(OrderRepository.getById(o.id).status).toBe('matched');
  });
});

describe('expireStaleDisputedOrders', () => {
  it('auto-resolves an old dispute as a refund -> cancelled by default', () => {
    process.env.ORDER_DISPUTE_TIMEOUT_DAYS = '0';
    const o = OrderRepository.create({
      status: 'disputed', userId: 'u1', providerId: 'p1',
      dispute: { raisedAt: OLD, reason: 'x' },
    });
    const count = expireStaleDisputedOrders();
    expect(count).toBeGreaterThanOrEqual(1);
    const after = OrderRepository.getById(o.id);
    expect(after.status).toBe('cancelled');
    expect(after.dispute.resolution.decision).toBe('refund');
    expect(after.dispute.resolution.resolvedBy).toBe('system');
  });

  it('auto-resolves as uphold -> completed when AUTO_DISPUTE_DECISION=uphold', () => {
    process.env.ORDER_DISPUTE_TIMEOUT_DAYS = '0';
    process.env.AUTO_DISPUTE_DECISION = 'uphold';
    const o = OrderRepository.create({
      status: 'disputed', userId: 'u2', providerId: 'p2',
      dispute: { raisedAt: OLD, reason: 'y' },
    });
    expireStaleDisputedOrders();
    const after = OrderRepository.getById(o.id);
    expect(after.status).toBe('completed');
    expect(after.dispute.resolution.decision).toBe('uphold');
  });
});

describe('expireStaleActiveOrders', () => {
  it('cancels an active order past the active timeout and returns its gpuId', () => {
    process.env.ORDER_ACTIVE_TIMEOUT_HOURS = '0'; // 0 -> falls back to default, so use an old start well beyond 48h
    const o = OrderRepository.create({ status: 'active', startedAt: OLD, userId: 'u3', gpuId: 'gpu-xyz' });
    const expired = expireStaleActiveOrders();
    expect(Array.isArray(expired)).toBe(true);
    const mine = expired.find((e) => e.id === o.id);
    expect(mine).toBeDefined();
    expect(mine.gpuId).toBe('gpu-xyz');
    expect(OrderRepository.getById(o.id).status).toBe('cancelled');
  });

  it('leaves a recently-started active order running', () => {
    const o = OrderRepository.create({ status: 'active', startedAt: new Date().toISOString(), userId: 'u3', gpuId: 'g' });
    expireStaleActiveOrders();
    expect(OrderRepository.getById(o.id).status).toBe('active');
  });
});
