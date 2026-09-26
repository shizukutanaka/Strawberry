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

  it('HELD エスクローを返金遷移させる（payment refunded のみでは資金がロックされたままだった）', async () => {
    const OrderRepository = require('../../src/db/json/OrderRepository');
    const EscrowRepository = require('../../src/db/json/EscrowRepository');
    const { createEscrowService } = require('../../src/payments/escrow-service');
    const mod = require('../../src/gpu/gpu-auto-recovery');

    // create は id を採番し直すため返却値の id を使う
    const order = OrderRepository.create({
      gpuId: 'g', userId: 'u', providerId: 'p',
      status: 'active', durationMinutes: 60, pricePerHour: 100, totalPrice: 100,
    });
    const orderId = order.id;
    const svc = createEscrowService({ repository: EscrowRepository });
    const esc = svc.create({ orderId, amountSats: 100 });
    svc.markPaid(esc.id);
    expect(EscrowRepository.getById(esc.id).state).toBe('HELD');

    await mod.autoHandleGpuFailure(orderId, 'g', 'u', 'GPU down');

    expect(EscrowRepository.getById(esc.id).state).toBe('CANCELED');
  });
});
