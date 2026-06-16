// invoice-poller underpayment guard.
// A settled Lightning invoice must cover the expected order amount before the
// payment is confirmed and the order advanced. Otherwise an attacker who can
// settle an invoice for less than requested would get a full-price order
// fulfilled for a fraction of the cost.
const poller = require('../../src/core/invoice-poller');
const PaymentRepository = require('../../src/db/json/PaymentRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');

function makeLightning(statusByHash) {
  return {
    checkInvoice: async (hash) => statusByHash[hash] || null,
  };
}

describe('invoice-poller underpayment guard', () => {
  afterEach(() => poller.stop());

  it('confirms payment and advances order when the settled amount is sufficient', async () => {
    const order = OrderRepository.create({ status: 'pending' });
    const payment = PaymentRepository.create({
      method: 'lightning', status: 'pending', paymentHash: `full-${Date.now()}`,
      amount: 100000, orderId: order.id, userId: 'u1',
    });

    poller.start(makeLightning({
      [payment.paymentHash]: { settled: true, value: 100000, amountPaid: 100000, settleDate: Date.now() },
    }));
    await poller.pollOnce();

    expect(PaymentRepository.getById(payment.id).status).toBe('paid');
    expect(OrderRepository.getById(order.id).status).toBe('matched');
  });

  it('rejects an underpaid invoice: marks payment failed and leaves order pending', async () => {
    const order = OrderRepository.create({ status: 'pending' });
    const payment = PaymentRepository.create({
      method: 'lightning', status: 'pending', paymentHash: `under-${Date.now()}`,
      amount: 100000, orderId: order.id, userId: 'u1',
    });

    // Invoice reports settled but only 1 sat was actually received.
    poller.start(makeLightning({
      [payment.paymentHash]: { settled: true, value: 1, amountPaid: 1, settleDate: Date.now() },
    }));
    await poller.pollOnce();

    const updated = PaymentRepository.getById(payment.id);
    expect(updated.status).toBe('failed');
    expect(updated.failReason).toBe('underpayment');
    expect(OrderRepository.getById(order.id).status).toBe('pending'); // not advanced
  });

  it('falls back to the value field when amountPaid is absent', async () => {
    const order = OrderRepository.create({ status: 'pending' });
    const payment = PaymentRepository.create({
      method: 'lightning', status: 'pending', paymentHash: `val-${Date.now()}`,
      amount: 50000, orderId: order.id, userId: 'u1',
    });

    poller.start(makeLightning({
      [payment.paymentHash]: { settled: true, value: 10, settleDate: Date.now() }, // value < amount, no amountPaid
    }));
    await poller.pollOnce();

    expect(PaymentRepository.getById(payment.id).status).toBe('failed');
    expect(OrderRepository.getById(order.id).status).toBe('pending');
  });
});
