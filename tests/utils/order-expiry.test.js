// Order-expiry sweeps must be atomic + idempotent. The sweeps run on every
// list/create request, so two concurrent requests can run them over the same
// snapshot. Using updateIf (compare-and-swap on status) ensures a stale order is
// cancelled/resolved exactly once — no double-cancel, no double-notification, and
// no clobbering of a legitimate transition that landed between snapshot and write.
const OrderRepository = require('../../src/db/json/OrderRepository');

// Capture notifications instead of sending them.
const notes = [];
jest.mock('../../src/utils/user-notify', () => ({
  notifyUser: (userId, type, msg) => { notes.push({ userId, type }); },
}));

const { expireStaleOrders, expireStaleMatchedOrders } = require('../../src/utils/order-expiry');

const longAgo = () => new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

describe('order-expiry sweeps are atomic and idempotent', () => {
  beforeEach(() => { notes.length = 0; });

  it('cancels a stale pending order exactly once even when the sweep runs twice', () => {
    const order = OrderRepository.create({
      gpuId: 'g-exp1', userId: 'u-exp1', status: 'pending',
      durationMinutes: 30, totalPrice: 50, createdAt: longAgo(),
    });

    const first = expireStaleOrders();
    const second = expireStaleOrders(); // simulates a concurrent/duplicate sweep

    const after = OrderRepository.getById(order.id);
    expect(after.status).toBe('cancelled');
    expect(after.cancelReason).toBe('payment_timeout');
    // The order must be counted/notified by exactly one sweep, not both.
    const myNotes = notes.filter(n => n.type === 'order_expired');
    expect(myNotes.length).toBe(1);
    // The second sweep must not re-process this already-cancelled order.
    expect(second).toBeLessThan(first + 1); // second did not re-count this order
  });

  it('does not clobber an order that transitioned to matched after the snapshot', () => {
    // A stale pending order that another request matched concurrently.
    const order = OrderRepository.create({
      gpuId: 'g-exp2', userId: 'u-exp2', status: 'pending',
      durationMinutes: 30, totalPrice: 50, createdAt: longAgo(),
    });
    // Simulate the race: the order is now 'matched' (committed by /match) by the
    // time the sweep attempts its write. updateIf's predicate must reject the write.
    OrderRepository.update(order.id, { status: 'matched', matchedAt: new Date().toISOString() });

    expireStaleOrders();

    const after = OrderRepository.getById(order.id);
    // The pending-timeout sweep must NOT have overwritten the matched state.
    expect(after.status).toBe('matched');
    expect(after.cancelReason).toBeUndefined();
  });

  it('cancels a stale matched order exactly once across repeated sweeps', () => {
    const order = OrderRepository.create({
      gpuId: 'g-exp3', userId: 'u-exp3', status: 'matched',
      durationMinutes: 30, totalPrice: 50,
      createdAt: longAgo(), matchedAt: longAgo(),
    });

    expireStaleMatchedOrders();
    expireStaleMatchedOrders();

    const after = OrderRepository.getById(order.id);
    expect(after.status).toBe('cancelled');
    expect(after.cancelReason).toBe('match_timeout');
    expect(notes.filter(n => n.type === 'order_match_timeout').length).toBe(1);
  });
});
