// tests/orders/active-timeout-settlement.test.js
//
// 主張:「精算は実提供量に応じて行う」（README・payout-ledger.js）。
// 問: **その「実提供量」は、借り手が /stop を押さなかった注文についてどこから来るのか。**
//
// 答（修正前）: どこからも来なかった。expireStaleActiveOrders は稼働実績を一切書かずに
// cancelled にしていて、payout-ledger の按分は測定値が無いので
// `unmeasured_abnormal_termination` に落ち、実提供割合 0 = 借り手へ全額返金になっていた。
// つまり **借りる → 接続情報を受け取る → GPU を使う → /stop を押さない → 放置** だけで
// 代金が全額戻る。帳簿は保存則を満たすので突き合わせは healthy を返す（金額は合っている。
// 合っていないのは受取人である）。
//
// さらに、期限が「開始から 48 時間」の固定値だったため、予約時間が 48 時間を超える
// 正当なレンタル（最大 30 日まで取れる）が稼働中に強制キャンセルされていた。
const OrderRepository = require('../../src/db/json/OrderRepository');
const PaymentRepository = require('../../src/db/json/PaymentRepository');
const accessDelivery = require('../../src/marketplace/access-delivery');
const { expireStaleActiveOrders } = require('../../src/utils/order-expiry');
const { settlementForOrder, deliveredRatioOf } = require('../../src/payments/payout-ledger');

const HOUR = 60 * 60 * 1000;
const PRICE = 100_000; // sats

function hoursAgo(h) { return new Date(Date.now() - h * HOUR).toISOString(); }

/** 稼働中の注文を 1 件作る。durationMinutes 分を予約し、started は startedHoursAgo 時間前。 */
function activeOrder({ durationMinutes, startedHoursAgo, withAccess = true, paid = true }) {
  const startedAt = hoursAgo(startedHoursAgo);
  const order = OrderRepository.create({
    userId: 'renter-ato', providerId: 'provider-ato', gpuId: 'gpu-ato',
    status: 'active', durationMinutes, totalPrice: PRICE,
    startedAt,
    scheduledStartAt: startedAt,
    scheduledEndAt: new Date(Date.parse(startedAt) + durationMinutes * 60 * 1000).toISOString(),
    accessDelivery: withAccess
      ? accessDelivery.seal({ method: 'ssh', endpoint: 'gpu.example.com:22', credential: 'k' })
      : null,
  });
  if (paid) {
    PaymentRepository.create({
      orderId: order.id, userId: 'renter-ato', status: 'paid', amount: PRICE,
      method: 'lightning', paidAt: startedAt,
    });
  }
  return order;
}

describe('a rental the renter never stopped', () => {
  it('is not cancelled while the booked window is still running (a long rental is not killed at 48h)', () => {
    // 7 日間の予約を 3 日目に掃く。旧実装は 48 時間で殺していた。
    const order = activeOrder({ durationMinutes: 7 * 24 * 60, startedHoursAgo: 72 });
    expireStaleActiveOrders();
    expect(OrderRepository.getById(order.id).status).toBe('active');
  });

  it('is not cancelled during the grace period after the booked end', () => {
    // 1 時間の予約、開始から 2 時間。予約は終わったが猶予（既定 48h）の中。
    const order = activeOrder({ durationMinutes: 60, startedHoursAgo: 2 });
    expireStaleActiveOrders();
    expect(OrderRepository.getById(order.id).status).toBe('active');
  });

  it('is settled as fully delivered once the booked window and the grace have both passed', () => {
    const order = activeOrder({ durationMinutes: 60, startedHoursAgo: 60 });
    expireStaleActiveOrders();

    const after = OrderRepository.getById(order.id);
    expect(after.status).toBe('cancelled');
    expect(after.cancelReason).toBe('active_timeout');
    // 実提供割合が**書かれている**ことがこの修正の要。書かれないと按分が測定値なしに落ちる。
    expect(after.deliveredRatio).toBe(1);
    expect(deliveredRatioOf(after)).toEqual({ ratio: 1, source: 'order.deliveredRatio' });

    // 金: 借り手は使った分を払い、プロバイダが受け取る。全額返金にならない。
    const s = settlementForOrder(after);
    expect(s.totalSats).toBe(PRICE);
    expect(s.renterRefundSats).toBe(0);
    expect(s.providerPayoutSats).toBeGreaterThan(0);
    expect(s.chargedSats).toBe(PRICE);
  });

  it('is refunded in full when the provider never handed over any connection details', () => {
    // 証拠主義: 接続情報を渡していないプロバイダに払う理由は無い。
    const order = activeOrder({ durationMinutes: 60, startedHoursAgo: 60, withAccess: false });
    expireStaleActiveOrders();

    const after = OrderRepository.getById(order.id);
    expect(after.status).toBe('cancelled');
    expect(after.deliveredRatio).toBe(0);

    const s = settlementForOrder(after);
    expect(s.renterRefundSats).toBe(PRICE);
    expect(s.providerPayoutSats).toBe(0);
  });

  it('closes the free-rental exploit: not stopping is no cheaper than stopping', () => {
    // 同じ注文を、押した場合と押さなかった場合で比べる。差が出るなら、押さない方が得になる。
    const stopped = OrderRepository.create({
      userId: 'renter-ato', providerId: 'provider-ato', gpuId: 'gpu-ato',
      status: 'completed', durationMinutes: 60, totalPrice: PRICE,
      startedAt: hoursAgo(60), stoppedAt: hoursAgo(59), completedAt: hoursAgo(59),
    });
    PaymentRepository.create({
      orderId: stopped.id, userId: 'renter-ato', status: 'paid', amount: PRICE,
      method: 'lightning', paidAt: hoursAgo(60),
    });
    const abandoned = activeOrder({ durationMinutes: 60, startedHoursAgo: 60 });
    expireStaleActiveOrders();

    const a = settlementForOrder(OrderRepository.getById(stopped.id));
    const b = settlementForOrder(OrderRepository.getById(abandoned.id));
    expect(b.chargedSats).toBe(a.chargedSats);
    expect(b.renterRefundSats).toBe(a.renterRefundSats);
    expect(b.providerPayoutSats).toBe(a.providerPayoutSats);
  });

  it('respects ORDER_ACTIVE_TIMEOUT_HOURS as the grace after the booked end, not the whole lifetime', () => {
    const prev = process.env.ORDER_ACTIVE_TIMEOUT_HOURS;
    process.env.ORDER_ACTIVE_TIMEOUT_HOURS = '1';
    try {
      // 予約 1 時間・開始 3 時間前 → 予約終了から 2 時間経過 > 猶予 1 時間 → 掃かれる。
      const swept = activeOrder({ durationMinutes: 60, startedHoursAgo: 3 });
      // 予約 10 時間・開始 3 時間前 → まだ予約時間の中 → 掃かれない。
      const running = activeOrder({ durationMinutes: 10 * 60, startedHoursAgo: 3 });
      expireStaleActiveOrders();
      expect(OrderRepository.getById(swept.id).status).toBe('cancelled');
      expect(OrderRepository.getById(running.id).status).toBe('active');
    } finally {
      if (prev === undefined) delete process.env.ORDER_ACTIVE_TIMEOUT_HOURS;
      else process.env.ORDER_ACTIVE_TIMEOUT_HOURS = prev;
    }
  });
});
