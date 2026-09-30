// デーモン系モジュールの定期タイマーが unref 済みであることの回帰テスト。
// unref しない setInterval はイベントループを生かし続けるため、
// プロセスが SIGTERM を受けても interval が残る限り終了しない
// （コンテナ環境では SIGKILL タイムアウトに化ける）。
jest.useFakeTimers();

const { AutoPerformanceOptimizer } = require('../../src/core/auto-performance-optimizer');
const { MetricsCollector } = require('../../src/gpu/metrics');

afterEach(() => {
  jest.clearAllTimers();
});

describe('AutoPerformanceOptimizer', () => {
  it('start() の interval は unref 済み（プロセス終了を妨げない）', () => {
    const opt = new AutoPerformanceOptimizer();
    opt.start(1000);
    expect(opt.interval.hasRef()).toBe(false);
    opt.stop();
  });

  it('interval ごとに optimize() が呼ばれる', () => {
    const opt = new AutoPerformanceOptimizer();
    const spy = jest.spyOn(opt, 'optimize').mockResolvedValue();
    opt.start(1000);
    jest.advanceTimersByTime(3500);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    opt.stop();
  });

  it('stop() がタイマーを解除し以降 optimize を呼ばない', () => {
    const opt = new AutoPerformanceOptimizer();
    const spy = jest.spyOn(opt, 'optimize').mockResolvedValue();
    opt.start(1000);
    opt.stop();
    expect(opt.interval).toBeNull();
    jest.advanceTimersByTime(5000);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('MetricsCollector', () => {
  it('startCollection の interval は unref 済みで stopCollection で解除される', () => {
    const mc = new MetricsCollector();
    const spy = jest.spyOn(mc, 'collectSystemMetrics').mockImplementation(() => {});
    jest.spyOn(mc, 'collectProcessMetrics').mockImplementation(() => {});
    mc.startCollection(1000);
    expect(mc.collectionInterval.hasRef()).toBe(false);
    jest.advanceTimersByTime(2500);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    mc.stopCollection();
    expect(mc.collectionInterval).toBeNull();
  });
});
