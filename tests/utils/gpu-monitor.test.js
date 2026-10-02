// gpu-monitor の自動リカバリ回帰テスト — 旧実装は
// (a) OrderRepository.updateStatus（存在しないメソッド）呼び出しで TypeError クラッシュ、
// (b) ORDER_STATES 非登録の 'auto_recovered' を書き込み注文を遷移不能にする、
// (c) getByOrderId（many:true=配列）を単体オブジェクト扱いし refundPayment（不在）を呼ぶ、
// という三重の実害を持っていた。
jest.mock('../../src/utils/resilient-notify', () => ({ resilientNotify: jest.fn().mockResolvedValue() }));
jest.mock('../../src/utils/anomaly-detector', () => ({ reportAnomaly: jest.fn() }));

const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const PaymentRepository = require('../../src/db/json/PaymentRepository');
const { monitorAndRecover, startGpuMonitor, stopGpuMonitor } = require('../../src/utils/gpu-monitor');

describe('gpu-monitor monitorAndRecover', () => {
  it('死活応答の無い GPU の active 注文を cancelled へ落とし支払いを refunded にする', async () => {
    const gpu = GpuRepository.create({
      name: 'dead-gpu', providerId: 'p1', pricePerHour: 100,
      lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10分前
    });
    const order = OrderRepository.create({
      userId: 'u1', gpuId: gpu.id, status: 'active',
      durationMinutes: 60, totalPrice: 100,
    });
    const payment = PaymentRepository.create({
      orderId: order.id, userId: 'u1', status: 'paid', amount: 100,
    });

    await monitorAndRecover();

    expect(OrderRepository.getById(order.id).status).toBe('cancelled');
    expect(PaymentRepository.getById(payment.id).status).toBe('refunded');
  });

  it('鮮度のある GPU の active 注文は触らない', async () => {
    const gpu = GpuRepository.create({
      name: 'alive-gpu', providerId: 'p1', pricePerHour: 100,
      lastHeartbeat: new Date().toISOString(),
    });
    const order = OrderRepository.create({
      userId: 'u1', gpuId: gpu.id, status: 'active',
      durationMinutes: 60, totalPrice: 100,
    });

    await monitorAndRecover();

    expect(OrderRepository.getById(order.id).status).toBe('active');
  });

  it('1 tick での GPU 参照は注文数に関わらず getAll 1回のみ（N+1 回帰）', async () => {
    for (const name of ['g1', 'g2', 'g3']) {
      const gpu = GpuRepository.create({
        name, providerId: 'p1', pricePerHour: 100,
        lastHeartbeat: new Date().toISOString(),
      });
      OrderRepository.create({
        userId: 'u1', gpuId: gpu.id, status: 'active',
        durationMinutes: 60, totalPrice: 100,
      });
    }
    const getAllSpy = jest.spyOn(GpuRepository, 'getAll');
    await monitorAndRecover();
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    getAllSpy.mockRestore();
  });
});

describe('gpu-monitor タイマー', () => {
  it('startGpuMonitor は unref 済みタイマーを返し多重起動せず stopGpuMonitor で止まる', () => {
    const t1 = startGpuMonitor();
    expect(t1.hasRef()).toBe(false);
    const t2 = startGpuMonitor();
    expect(t2).toBe(t1);
    stopGpuMonitor();
    // 再始動できる（新しいタイマーが返る）
    const t3 = startGpuMonitor();
    expect(t3).not.toBe(t1);
    stopGpuMonitor();
  });
});
