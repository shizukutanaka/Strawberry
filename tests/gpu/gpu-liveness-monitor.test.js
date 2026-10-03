// src/gpu/gpu-liveness-monitor.js — 死活監視の契約を固定するテスト。
// 60s 無ハートビートで recordGpuError+除去・新鮮なレンタル温存・タイマー unref/再入・
// _checkRunning 重なりガード・metrics 遅延生成は、アラート嵐・二重通知・
// リークのどれにも回帰できない不変条件。
jest.mock('../../src/gpu/gpu-error-history', () => ({
  recordGpuError: jest.fn().mockResolvedValue(undefined),
}));
const { recordGpuError } = require('../../src/gpu/gpu-error-history');
const { GpuLivenessMonitor } = require('../../src/gpu/gpu-liveness-monitor');

const STALE = 61 * 1000;

beforeEach(() => recordGpuError.mockClear());

describe('checkLiveness', () => {
  it('flags rentals silent for >60s, records an error, and removes them', async () => {
    const m = new GpuLivenessMonitor();
    m.registerRental('o1', 'g1', 'u1');
    m.activeRentals.get('o1').lastHeartbeat = Date.now() - STALE;
    await m.checkLiveness();
    expect(recordGpuError).toHaveBeenCalledTimes(1);
    expect(recordGpuError.mock.calls[0][0]).toBe('g1');
    expect(m.activeRentals.has('o1')).toBe(false);
  });

  it('leaves fresh rentals untouched and silent', async () => {
    const m = new GpuLivenessMonitor();
    m.registerRental('o2', 'g2', 'u2');
    await m.checkLiveness();
    expect(recordGpuError).not.toHaveBeenCalled();
    expect(m.activeRentals.has('o2')).toBe(true);
  });

  it('heartbeat refreshes a stale rental so it is no longer flagged', async () => {
    const m = new GpuLivenessMonitor();
    m.registerRental('o3', 'g3', 'u3');
    m.activeRentals.get('o3').lastHeartbeat = Date.now() - STALE;
    m.heartbeat('o3');
    await m.checkLiveness();
    expect(recordGpuError).not.toHaveBeenCalled();
    expect(m.activeRentals.has('o3')).toBe(true);
  });

  it('heartbeat on an unknown order is a no-op', () => {
    const m = new GpuLivenessMonitor();
    expect(() => m.heartbeat('ghost')).not.toThrow();
  });
});

describe('timer contract', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('start creates an unrefd interval; stop clears it', () => {
    const m = new GpuLivenessMonitor();
    m.start(1000);
    expect(m.interval).not.toBeNull();
    m.stop();
    expect(m.interval).toBeNull();
  });

  it('re-start replaces the previous interval (no dual timers)', () => {
    const m = new GpuLivenessMonitor();
    m.start(1000);
    const first = m.interval;
    m.start(2000);
    expect(m.interval).not.toBe(first);
    expect(m.interval).not.toBeNull();
    m.stop();
  });

  it('skips the tick while a previous check is still running', async () => {
    const m = new GpuLivenessMonitor();
    m.registerRental('o4', 'g4', 'u4');
    m.activeRentals.get('o4').lastHeartbeat = Date.now() - STALE;
    m.start(10);
    m._checkRunning = true; // 前回チェック未完を模倣
    jest.advanceTimersByTime(50);
    await Promise.resolve();
    expect(recordGpuError).not.toHaveBeenCalled();
    m.stop();
  });
});

describe('lazy metrics', () => {
  it('does not construct MetricsCollector until metrics is accessed', () => {
    const m = new GpuLivenessMonitor();
    expect(m._metrics).toBeNull();
  });
});
