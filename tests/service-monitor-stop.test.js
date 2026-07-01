// tests/service-monitor-stop.test.js
//
// Regression for a resource-leak bug found while running the full test suite
// directly with `npx jest` (without the `npm test` script's `--forceExit` flag):
// the process kept running for hours afterward, writing hundreds of megabytes
// to logs/audit.log and logs/error.log, with CPU pinned near 80%.
//
// Root cause: service-monitor.js's startMonitor() creates a setInterval that
// polls all registered services every 10 seconds, but the module exported no
// way to stop it. src/api/server.js calls startMonitor() unconditionally at
// module-load time (not gated behind `require.main === module`), so every test
// file that requires server.js (directly or transitively, e.g. via supertest)
// leaves behind a real, uncleared interval in the Jest worker process. Across
// the dozens of integration test files that import server.js, these intervals
// accumulate in the same worker process (Jest isolates each test file's module
// registry, but NOT real OS timers, which live in the actual Node event loop).
//
// This has zero impact on `npm test` (masked by --forceExit) and zero impact on
// production (the process always fully exits via process.exit() on graceful
// shutdown, taking every timer with it) — but it is a real, observable leak for
// anyone running `jest` directly (IDE test runners, `jest --watch`, misconfigured
// CI that drops the flag).
//
// Fix: export stopMonitor() so the interval can be explicitly cleared.

const serviceMonitor = require('../src/core/service-monitor');

describe('service-monitor: stopMonitor clears the interval (leak-prevention capability)', () => {
  afterEach(() => {
    // Always leave the module in a stopped state so this test file itself
    // doesn't contribute to the exact leak it's testing for.
    serviceMonitor.stopMonitor();
    jest.useRealTimers();
  });

  it('exports a stopMonitor function (the core fix: it did not exist at all)', () => {
    expect(typeof serviceMonitor.stopMonitor).toBe('function');
  });

  it('stops monitorServices from firing again after stopMonitor() is called', async () => {
    // setInterval(monitorServices, ...) inside startMonitor() closes over the
    // module's own internal function reference, not module.exports.monitorServices
    // — so jest.spyOn(serviceMonitor, 'monitorServices') would not intercept the
    // interval's calls. Instead, observe a side effect: monitorServices() calls
    // isHealthy() on every registered service every tick. monitorServices is
    // async, so advanceTimersByTimeAsync (not the sync variant) is needed to let
    // its internal awaits resolve between ticks.
    jest.useFakeTimers();
    const isHealthy = jest.fn().mockResolvedValue(true);
    serviceMonitor.setServices({ fakeService: { initialized: true, isHealthy } });

    serviceMonitor.startMonitor();
    await jest.advanceTimersByTimeAsync(10000);
    expect(isHealthy).toHaveBeenCalledTimes(1);

    serviceMonitor.stopMonitor();
    await jest.advanceTimersByTimeAsync(50000);
    // No further calls after stopping, no matter how much time passes.
    expect(isHealthy).toHaveBeenCalledTimes(1);
  });

  it('is safe to call stopMonitor() when no monitor was started (idempotent)', () => {
    expect(() => serviceMonitor.stopMonitor()).not.toThrow();
    expect(() => serviceMonitor.stopMonitor()).not.toThrow();
  });

  it('is safe to call stopMonitor() twice in a row after starting (idempotent)', () => {
    jest.useFakeTimers();
    serviceMonitor.startMonitor();
    expect(() => {
      serviceMonitor.stopMonitor();
      serviceMonitor.stopMonitor();
    }).not.toThrow();
  });

  it('clears the registered services reference on stop (no stale service handles retained)', () => {
    serviceMonitor.setServices({ fakeService: { initialized: true } });
    serviceMonitor.stopMonitor();
    // monitorServices iterates over the internal `services` object; after stop,
    // a fresh call should have nothing to check (no leftover stale references).
    return expect(serviceMonitor.monitorServices()).resolves.toBeUndefined();
  });
});
