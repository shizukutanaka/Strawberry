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
  // ポーラーはモジュール単位のシングルトンで、src/api/server.js を読み込む
  // 全スイート（30 本以上）が 15 秒間隔でこれを起動する。同じ jest ワーカー内で
  // その interval が発火すると再入ガード（_running）に当たり、こちらの
  // pollOnce() が黙って何もせず返る＝断続的に「pending のまま」で落ちる。
  // このスイートがシングルトンを占有できるよう、前後で必ず止める。
  beforeEach(() => poller.stop());
  afterEach(() => poller.stop());

  // 背景 interval（src/api/server.js を読み込む 30 本以上のスイートが起動する）と
  // 再入ガードで衝突すると pollOnce() は何もせず返る。実際に巡回できるまで待つ。
  async function pollUntilRan() {
    for (let i = 0; i < 50; i++) {
      const r = await poller.pollOnce();
      if (r && r.ran) return r;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error('invoice-poller never ran (re-entrancy guard never cleared)');
  }

  it('confirms payment and advances order when the settled amount is sufficient', async () => {
    const order = OrderRepository.create({ status: 'pending' });
    const payment = PaymentRepository.create({
      method: 'lightning', status: 'pending', paymentHash: `full-${Date.now()}`,
      amount: 100000, orderId: order.id, userId: 'u1',
    });

    poller.start(makeLightning({
      [payment.paymentHash]: { settled: true, value: 100000, amountPaid: 100000, settleDate: Date.now() },
    }));
    await pollUntilRan();

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
    await pollUntilRan();

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
    await pollUntilRan();

    expect(PaymentRepository.getById(payment.id).status).toBe('failed');
    expect(OrderRepository.getById(order.id).status).toBe('pending');
  });
});
