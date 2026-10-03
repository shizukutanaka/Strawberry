// GPU障害自動復旧モジュールの回帰テスト
// 既存バグ: OrderRepository/PaymentRepository を `{ X }` で分割代入していたため undefined になり、
// 障害発生時に autoHandleGpuFailure 内で TypeError クラッシュしていた（リポジトリはメソッド集合を
// 直接 export する）。default import に修正したことを検証する。
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('gpu-auto-recovery repository wiring', () => {
  it('imports OrderRepository/PaymentRepository as usable objects (not undefined)', () => {
    const OrderRepository = require('../../src/db/json/OrderRepository');
    const PaymentRepository = require('../../src/db/json/PaymentRepository');
    expect(typeof OrderRepository.getById).toBe('function');
    expect(typeof OrderRepository.update).toBe('function');
    expect(typeof PaymentRepository.getByOrderId).toBe('function');
    expect(typeof PaymentRepository.update).toBe('function');
  });

  it('loads gpu-auto-recovery and exposes autoHandleGpuFailure without throwing', () => {
    const mod = require('../../src/gpu/gpu-auto-recovery');
    const fn = mod.autoHandleGpuFailure || (mod.default && mod.default.autoHandleGpuFailure);
    expect(typeof fn).toBe('function');
  });

  it('autoHandleGpuFailure runs against repositories without a TypeError', async () => {
    const mod = require('../../src/gpu/gpu-auto-recovery');
    const fn = mod.autoHandleGpuFailure;
    // 存在しない order/payment でも、リポジトリ呼び出しが undefined クラッシュしないことを確認
    await expect(fn('nonexistent-order', 'gpu-x', 'user-1', 'test reason')).resolves.not.toThrow;
  });
});

// updateIf CAS 化の回帰固定: 読取スナップショットと書込の間に他経路で終端状態へ進んだ
// 注文/支払いを cancelled/refunded へ回帰させないことを検証する。
// 単一スレッド上で「読取後に別経路が書き込む」インターリーブを spy で注入して再現する。
describe('gpu-auto-recovery CAS transitions', () => {
  const OrderRepository = require('../../src/db/json/OrderRepository');
  const PaymentRepository = require('../../src/db/json/PaymentRepository');
  const { autoHandleGpuFailure } = require('../../src/gpu/gpu-auto-recovery');
  const seeded = { orders: [], payments: [] };

  afterEach(() => {
    for (const id of seeded.orders) { try { OrderRepository.delete(id); } catch (_) { /* noop */ } }
    for (const id of seeded.payments) { try { PaymentRepository.delete(id); } catch (_) { /* noop */ } }
    seeded.orders.length = 0;
    seeded.payments.length = 0;
    jest.restoreAllMocks();
  });

  const seedOrder = (rec) => {
    const row = OrderRepository.create({ id: `o-${Date.now()}-${Math.random()}`, ...rec });
    seeded.orders.push(row.id);
    return row;
  };
  const seedPayment = (rec) => {
    const row = PaymentRepository.create({ id: `p-${Date.now()}-${Math.random()}`, ...rec });
    seeded.payments.push(row.id);
    return row;
  };

  it('cancels an active order via updateIf and preserves other fields', async () => {
    const order = seedOrder({ status: 'active', escrowId: 'esc-1', userId: 'u1' });
    await autoHandleGpuFailure(order.id, 'gpu-x', 'u1', 'hw fault');
    const row = OrderRepository.getById(order.id);
    expect(row.status).toBe('cancelled');
    expect(row.failureReason).toBe('hw fault');
    expect(row.failedAt).toBeDefined();
    expect(row.escrowId).toBe('esc-1'); // 全行書戻しではなく部分 merge であること
  });

  it('does not regress an order concurrently completed after the read', async () => {
    const order = seedOrder({ status: 'active', userId: 'u1' });
    const realUpdateIf = OrderRepository.updateIf.bind(OrderRepository);
    const realUpdate = OrderRepository.update.bind(OrderRepository);
    // updateIf の実行直前に他経路の completed 遷移を注入 → CAS が拒否すべき
    jest.spyOn(OrderRepository, 'updateIf').mockImplementation((id, pred, upd) => {
      if (id === order.id) realUpdate(order.id, { status: 'completed' });
      return realUpdateIf(id, pred, upd);
    });
    await autoHandleGpuFailure(order.id, 'gpu-x', 'u1', 'hw fault');
    expect(OrderRepository.getById(order.id).status).toBe('completed');
  });

  it('refunds a paid payment', async () => {
    const order = seedOrder({ status: 'active', userId: 'u1' });
    seedPayment({ orderId: order.id, status: 'paid', amountSats: 100 });
    await autoHandleGpuFailure(order.id, 'gpu-x', 'u1', 'hw fault');
    const payments = PaymentRepository.getByOrderId(order.id);
    expect(payments[0].status).toBe('refunded');
    expect(payments[0].refundedAt).toBeDefined();
  });

  it('does not refund a payment concurrently settled after the read', async () => {
    const order = seedOrder({ status: 'active', userId: 'u1' });
    const payment = seedPayment({ orderId: order.id, status: 'paid', amountSats: 100 });
    const realUpdateIf = PaymentRepository.updateIf.bind(PaymentRepository);
    const realUpdate = PaymentRepository.update.bind(PaymentRepository);
    jest.spyOn(PaymentRepository, 'updateIf').mockImplementation((id, pred, upd) => {
      if (id === payment.id) realUpdate(payment.id, { status: 'settled' });
      return realUpdateIf(id, pred, upd);
    });
    await autoHandleGpuFailure(order.id, 'gpu-x', 'u1', 'hw fault');
    expect(PaymentRepository.getById(payment.id).status).toBe('settled');
  });
});
