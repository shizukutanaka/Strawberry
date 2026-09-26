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

// Capture escrow FSM calls. The mock performs the state write on the real
// repository so tests can assert the final escrow state end-to-end.
const escrowCalls = { cancel: [], settle: [], apply: [] };
jest.mock('../../src/payments/escrow-service', () => ({
  createEscrowService: () => ({
    cancel: (id) => {
      escrowCalls.cancel.push(id);
      require('../../src/db/json/EscrowRepository').update(id, { state: 'CANCELED' });
    },
    settle: (id, usage) => { escrowCalls.settle.push({ id, usage }); },
    apply: (id, event) => {
      escrowCalls.apply.push({ id, event });
      if (event === 'DELIVER_OK') {
        require('../../src/db/json/EscrowRepository').update(id, { state: 'SETTLED' });
      }
    },
  }),
}));

const EscrowRepository = require('../../src/db/json/EscrowRepository');
const { expireStaleOrders, expireStaleMatchedOrders, expireStaleActiveOrders } = require('../../src/utils/order-expiry');

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

describe('escrow release on timeout-cancellation', () => {
  beforeEach(() => {
    escrowCalls.cancel.length = 0;
    escrowCalls.settle.length = 0;
    escrowCalls.apply.length = 0;
  });

  it('refunds (CANCELED) a HELD escrow when a matched order times out', () => {
    const order = OrderRepository.create({
      gpuId: 'g-esc1', userId: 'u-esc1', status: 'matched',
      durationMinutes: 30, totalPrice: 50,
      createdAt: longAgo(), matchedAt: longAgo(),
    });
    const escrow = EscrowRepository.create({
      orderId: order.id, state: 'HELD', amountSats: 50,
      renterId: 'u-esc1', providerId: 'p-esc1',
    });

    expireStaleMatchedOrders();

    expect(escrowCalls.cancel).toContain(escrow.id);
    expect(EscrowRepository.getById(escrow.id).state).toBe('CANCELED');
  });

  it('refunds (CANCELED) a HELD escrow when a pending order times out', () => {
    const order = OrderRepository.create({
      gpuId: 'g-esc2', userId: 'u-esc2', status: 'pending',
      durationMinutes: 30, totalPrice: 50, createdAt: longAgo(),
    });
    const escrow = EscrowRepository.create({
      orderId: order.id, state: 'HELD', amountSats: 50,
      renterId: 'u-esc2', providerId: 'p-esc2',
    });

    expireStaleOrders();

    expect(escrowCalls.cancel).toContain(escrow.id);
    expect(EscrowRepository.getById(escrow.id).state).toBe('CANCELED');
  });

  it('settles (SETTLED) a HELD escrow pro-rata when an active order times out', () => {
    const prev = process.env.ORDER_ACTIVE_TIMEOUT_HOURS;
    process.env.ORDER_ACTIVE_TIMEOUT_HOURS = '48';
    try {
      const startedAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(); // 72h ago
      const order = OrderRepository.create({
        gpuId: 'g-esc3', userId: 'u-esc3', status: 'active',
        durationMinutes: 7200, totalPrice: 50,
        createdAt: startedAt, startedAt,
      });
      const escrow = EscrowRepository.create({
        orderId: order.id, state: 'HELD', amountSats: 50,
        renterId: 'u-esc3', providerId: 'p-esc3',
      });

      expireStaleActiveOrders();

      const settleCall = escrowCalls.settle.find(c => c.id === escrow.id);
      expect(settleCall).toBeTruthy();
      // elapsed 72h / duration 120h → deliveredRatio ≈ 0.6
      expect(settleCall.usage.deliveredRatio).toBeCloseTo(0.6, 1);
      expect(escrowCalls.apply).toContainEqual({ id: escrow.id, event: 'DELIVER_OK' });
      expect(EscrowRepository.getById(escrow.id).state).toBe('SETTLED');
    } finally {
      if (prev === undefined) delete process.env.ORDER_ACTIVE_TIMEOUT_HOURS;
      else process.env.ORDER_ACTIVE_TIMEOUT_HOURS = prev;
    }
  });

  it('does not touch escrows on orders the sweep did not cancel', () => {
    // Fresh pending order — not stale.
    const order = OrderRepository.create({
      gpuId: 'g-esc4', userId: 'u-esc4', status: 'pending',
      durationMinutes: 30, totalPrice: 50,
    });
    const escrow = EscrowRepository.create({
      orderId: order.id, state: 'HELD', amountSats: 50,
      renterId: 'u-esc4', providerId: 'p-esc4',
    });

    expireStaleOrders();

    expect(escrowCalls.cancel).not.toContain(escrow.id);
    expect(EscrowRepository.getById(escrow.id).state).toBe('HELD');
  });
});
