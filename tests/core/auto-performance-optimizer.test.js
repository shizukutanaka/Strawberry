// src/core/auto-performance-optimizer.js — optimize() の閾値判定・ログローテーション配線を固定するテスト。
// 修正対象: gpuStats.utilization/bandwidth のキー取り違え（実際は gpuUtilization /
// networkMetrics.bandwidth）で両アクションが死んでいた潜伏不具合 + 分毎追記の
// appendFileSync 無制限増殖（#75 の appendRotated 規約へ統一）。
jest.mock('../../src/gpu/metrics', () => ({
  MetricsCollector: jest.fn().mockImplementation(() => ({
    gpuMetrics: {}, networkMetrics: {},
  })),
}));
jest.mock('../../src/utils/log-rotate', () => ({
  appendRotated: jest.fn(),
  ensureLogDir: jest.fn(),
}));
const os = require('os');
const { appendRotated, ensureLogDir } = require('../../src/utils/log-rotate');
const { AutoPerformanceOptimizer } = require('../../src/core/auto-performance-optimizer');
const { logger } = require('../../src/utils/logger');

const gauge = (value) => ({ get: () => ({ values: value === null ? [] : [{ value }] }) });

let metricSpy;
beforeEach(() => {
  appendRotated.mockClear();
  ensureLogDir.mockClear();
  metricSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('optimize() thresholds', () => {
  it('triggers defer_new_gpu_jobs when GPU utilization exceeds 95', async () => {
    const o = new AutoPerformanceOptimizer();
    o.metrics.gpuMetrics.gpuUtilization = gauge(96);
    await o.optimize();
    const entry = metricSpy.mock.calls[0][1];
    expect(entry.gpuUsage).toBe(96);
    expect(entry.actions).toContain('defer_new_gpu_jobs');
  });

  it('triggers limit_p2p_bandwidth when network bandwidth exceeds 100MiB', async () => {
    const o = new AutoPerformanceOptimizer();
    o.metrics.networkMetrics.bandwidth = gauge(200 * 1024 * 1024);
    await o.optimize();
    const entry = metricSpy.mock.calls[0][1];
    expect(entry.bandwidth).toBe(200 * 1024 * 1024);
    expect(entry.actions).toContain('limit_p2p_bandwidth');
  });

  it('triggers reduce_background_tasks/clear_cache on host pressure', async () => {
    jest.spyOn(os, 'loadavg').mockReturnValue([5, 5, 5]);
    jest.spyOn(os, 'freemem').mockReturnValue(1);
    jest.spyOn(os, 'totalmem').mockReturnValue(100);
    const o = new AutoPerformanceOptimizer();
    await o.optimize();
    const entry = metricSpy.mock.calls[0][1];
    expect(entry.actions).toEqual(expect.arrayContaining(['reduce_background_tasks', 'clear_cache']));
  });

  it('logs with appendRotated (not unbounded appendFileSync) after ensureLogDir', async () => {
    const o = new AutoPerformanceOptimizer();
    await o.optimize();
    expect(ensureLogDir).toHaveBeenCalledWith(expect.stringContaining('perf-optimizer.log'));
    expect(appendRotated).toHaveBeenCalledWith(
      expect.stringContaining('perf-optimizer.log'),
      expect.stringContaining('"actions"'),
    );
  });

  it('swallows internal errors (optimize never throws)', async () => {
    appendRotated.mockImplementation(() => { throw new Error('disk full'); });
    const errSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const o = new AutoPerformanceOptimizer();
    await expect(o.optimize()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('timer contract', () => {
  it('start creates an unrefd interval; stop clears it', () => {
    const o = new AutoPerformanceOptimizer();
    o.start(1000);
    expect(o.interval).not.toBeNull();
    o.stop();
    expect(o.interval).toBeNull();
  });
});
