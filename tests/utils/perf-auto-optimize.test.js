// src/utils/perf-auto-optimize.js の検証。
// - getCpuUsage / getMemUsage が [0,1] の使用率を返す
// - autoOptimize が閾値未満では通知しない
// - startAutoOptimize のタイマーが unref 済み・再呼出しで多重化しない・stop で解除される
const os = require('os');

jest.mock('../../src/utils/resilient-notify', () => ({ resilientNotify: jest.fn().mockResolvedValue() }));
const { resilientNotify } = require('../../src/utils/resilient-notify');
const perf = require('../../src/utils/perf-auto-optimize');

describe('perf-auto-optimize', () => {
  afterEach(() => {
    perf.stopAutoOptimize();
    jest.restoreAllMocks();
  });

  test('getMemUsage は [0,1] の使用率を返す', () => {
    const mem = perf.getMemUsage();
    expect(mem).toBeGreaterThanOrEqual(0);
    expect(mem).toBeLessThanOrEqual(1);
  });

  test('getCpuUsage は [0,1] の使用率を返す', async () => {
    const cpu = await perf.getCpuUsage();
    expect(cpu).toBeGreaterThanOrEqual(0);
    expect(cpu).toBeLessThanOrEqual(1);
  }, 5000);

  test('autoOptimize: 閾値未満では通知しない', async () => {
    resilientNotify.mockClear();
    // cpu 差分 0（使用率 NaN→比較 false）・空きメモリ = 全量（使用率 ≈0）
    jest.spyOn(os, 'cpus').mockReturnValue([{ times: { idle: 1000, user: 0, nice: 0, sys: 0, irq: 0 } }]);
    jest.spyOn(os, 'freemem').mockReturnValue(os.totalmem());
    await perf.autoOptimize();
    expect(resilientNotify).not.toHaveBeenCalled();
  });

  test('autoOptimize: 高負荷時は resilientNotify で通知する', async () => {
    resilientNotify.mockClear();
    // CPU 100%・空きメモリ 0 をモック
    jest.spyOn(os, 'cpus')
      .mockReturnValueOnce([{ times: { idle: 0, user: 1000, nice: 0, sys: 0, irq: 0 } }])
      .mockReturnValue([{ times: { idle: 0, user: 2000, nice: 0, sys: 0, irq: 0 } }]);
    jest.spyOn(os, 'freemem').mockReturnValue(0);
    await perf.autoOptimize();
    expect(resilientNotify).toHaveBeenCalledTimes(1);
    expect(resilientNotify.mock.calls[0][0]).toContain('高負荷');
  });

  test('startAutoOptimize: タイマーは unref 済みで再呼出しでも多重化しない', () => {
    const spy = jest.spyOn(global, 'clearInterval');
    perf.startAutoOptimize();
    const first = perf._getOptimizeTimer();
    expect(first.hasRef()).toBe(false);
    perf.startAutoOptimize();
    expect(spy).toHaveBeenCalledWith(first); // 旧タイマーを解除
    expect(perf._getOptimizeTimer()).not.toBe(first);
    perf.stopAutoOptimize();
    expect(perf._getOptimizeTimer()).toBeNull();
  });
});
