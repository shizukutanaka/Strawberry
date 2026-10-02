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

describe('invoice-poller stat-gated idle skip', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    poller.stop();
  });

  it('skips the full payments parse while the file is unchanged and nothing is pending', async () => {
    poller.start(makeLightning({}));
    // start() の即時スキャンで pending=0 と指紋が確定済み
    const spy = jest.spyOn(PaymentRepository, 'getAll');
    await poller.pollOnce();
    await poller.pollOnce();
    expect(spy).not.toHaveBeenCalled();
  });

  it('re-reads payments.json once it changes', async () => {
    poller.start(makeLightning({}));
    const spy = jest.spyOn(PaymentRepository, 'getAll');
    PaymentRepository.create({
      method: 'lightning', status: 'pending', paymentHash: `chg-${Date.now()}`,
      amount: 1, orderId: null, userId: 'u1',
    });
    await poller.pollOnce();
    expect(spy).toHaveBeenCalled();
  });
});

describe('invoice-poller N+1 batching', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    poller.stop();
  });

  it('settled インボイスが複数あっても注文/支払い参照は tick あたり1回の一括読込', async () => {
    // 空 lightning で start() — 即時スキャンは pending=0 で await を踏まず同期完了する
    poller.start(makeLightning({}));
    const payments = [1, 2, 3].map((i) => {
      const order = OrderRepository.create({ status: 'pending' });
      return PaymentRepository.create({
        method: 'lightning', status: 'pending', paymentHash: `n1-${i}-${Date.now()}`,
        amount: 100, orderId: order.id, userId: 'u1',
      });
    });
    const getAllSpy = jest.spyOn(OrderRepository, 'getAll');
    const getByIdSpy = jest.spyOn(OrderRepository, 'getById');
    const getByOrderIdSpy = jest.spyOn(PaymentRepository, 'getByOrderId');
    // stop→start で _lightning を差し替えつつ即時 pollOnce が走る（マップ構築は start() 内で同期実行）
    poller.stop();
    poller.start(makeLightning(Object.fromEntries(
      payments.map((p) => [p.paymentHash, { settled: true, value: 100, amountPaid: 100, settleDate: Date.now() }])
    )));
    // インフライトの run は microtask のみで完走するため macrotask 1つ分待つ
    await new Promise((r) => setTimeout(r, 0));

    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(getByIdSpy).not.toHaveBeenCalled();
    expect(getByOrderIdSpy).not.toHaveBeenCalled();
    for (const p of payments) {
      expect(PaymentRepository.getById(p.id).status).toBe('paid');
    }
  });

  it('期限切れでも tick 中に他経路が paid へ進めた決済は failed に回帰させない（CAS）', async () => {
    poller.start(makeLightning({}));
    const payment = PaymentRepository.create({
      method: 'lightning', status: 'pending', paymentHash: `exp-${Date.now()}`,
      amount: 100, orderId: 'o1', userId: 'u1',
      invoiceExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    poller.stop();
    // checkInvoice の await 中に「別プロセスの手動承認」が paid へ書き換えた状況を再現
    poller.start({
      checkInvoice: async () => {
        PaymentRepository.update(payment.id, { status: 'paid', paidAt: new Date().toISOString() });
        return null; // settled ではない → expired 分岐へ
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(PaymentRepository.getById(payment.id).status).toBe('paid');
  });
});
