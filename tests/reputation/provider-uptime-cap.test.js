// provider-uptime の揮発状態（lastProviderBeatByOrder / countedOrders）が
// orderId ごとに永久蓄積するリークを、挿入順逐出キャップで防ぐ検証。

jest.mock('../../src/db/json/UptimeRepository', () => ({
  getByProviderId: jest.fn(() => null),
  create: jest.fn(() => ({})),
  update: jest.fn(() => ({})),
}));

describe('provider-uptime 揮発状態の上限', () => {
  const loadModule = () => {
    jest.resetModules();
    process.env.UPTIME_MAX_TRACKED_ORDERS = '100';
    return require('../../src/reputation/provider-uptime');
  };

  afterEach(() => {
    delete process.env.UPTIME_MAX_TRACKED_ORDERS;
  });

  test('orderId 数が上限を超えると最古から逐出される', () => {
    const up = loadModule();
    for (let i = 0; i < 150; i++) {
      up.recordProviderHeartbeat('p1', `order-${i}`, 1000 + i);
    }
    expect(up._lastProviderBeatByOrder.size).toBe(100);
    expect(up._countedOrders.size).toBe(100);
    // 最古の order-0..49 は逐出済み、最新 order-149 は残る
    expect(up._lastProviderBeatByOrder.has('order-0')).toBe(false);
    expect(up._lastProviderBeatByOrder.has('order-49')).toBe(false);
    expect(up._lastProviderBeatByOrder.has('order-149')).toBe(true);
    expect(up._countedOrders.has('order-0')).toBe(false);
    expect(up._countedOrders.has('order-149')).toBe(true);
  });

  test('逐出された注文の再ビートは初回扱い（偽の gap を生まない）', () => {
    const up = loadModule();
    const UptimeRepository = require('../../src/db/json/UptimeRepository');
    // gap 判定には GAP_THRESHOLD_MS 超の間隔が要る: 先にキャップを超える件数を記録して
    // order-old を逐出し、その後巨大な時刻差で再ビートしても gap にはならない。
    up.recordProviderHeartbeat('p1', 'order-old', 0);
    for (let i = 0; i < 100; i++) {
      up.recordProviderHeartbeat('p1', `order-${i}`, i + 1);
    }
    expect(up._lastProviderBeatByOrder.has('order-old')).toBe(false);
    // create() が呼ばれるたびに新規扱い（fake は常に null を返す）
    const before = UptimeRepository.create.mock.calls.length;
    // 巨大な経過時間でも「初回ビート扱い」→ gapEvents=0 の新規レコード
    up.recordProviderHeartbeat('p1', 'order-old', 10_000_000_000);
    expect(UptimeRepository.create).toHaveBeenCalledTimes(before + 1);
    const arg = UptimeRepository.create.mock.calls.at(-1)[0];
    expect(arg.gapEvents).toBe(0);
    expect(arg.sessions).toBe(1);
  });

  test('同一 orderId の連続ビートは逐出対象にならず集計も安定する', () => {
    const up = loadModule();
    // 上限未満の件数なら逐出が発生せず、gap 判定も通常通り動く
    up.recordProviderHeartbeat('p1', 'order-a', 0);
    up.recordProviderHeartbeat('p1', 'order-a', 1);
    expect(up._lastProviderBeatByOrder.size).toBe(1);
    expect(up._countedOrders.size).toBe(1);
  });
});
