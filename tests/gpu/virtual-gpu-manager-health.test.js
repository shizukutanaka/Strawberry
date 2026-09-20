// tests/gpu/virtual-gpu-manager-health.test.js
//
// Regression: VirtualGPUManager.isHealthy() returned false whenever no virtual
// GPU was allocated, which is the normal state of a freshly started server (no
// GPU has been rented yet). src/core/service-monitor.js treats "unhealthy" as a
// fault and calls initialize() again, so a live server logged
//
//   [Monitor] VirtualGPUManager unhealthy. Attempting restart.
//   [Monitor] VirtualGPUManager restarted successfully.
//
// every monitor tick (10s) forever — re-running GPU detection shell commands
// and config-restore I/O each time. Observed live on `PORT=3998 node
// src/api/server.js`.
//
// Fix: inventory count is not a liveness signal. isHealthy() now checks the
// initialized flag only (platform is always 'native' now).

const { VirtualGPUManager } = require('../../virtual-gpu-manager');

function makeManager({ initialized = true } = {}) {
  const m = new VirtualGPUManager();
  m.initialized = initialized;
  m.virtualGPUs = new Map();
  return m;
}

describe('VirtualGPUManager.isHealthy()', () => {
  it('is healthy on native platform with ZERO virtual GPUs (the bug)', async () => {
    const m = makeManager();
    expect(m.virtualGPUs.size).toBe(0);
    await expect(m.isHealthy()).resolves.toBe(true);
  });

  it('stays healthy once virtual GPUs exist', async () => {
    const m = makeManager();
    m.virtualGPUs.set('vgpu-1', { id: 'vgpu-1' });
    await expect(m.isHealthy()).resolves.toBe(true);
  });

  it('is unhealthy before initialize() completes', async () => {
    const m = makeManager({ initialized: false });
    await expect(m.isHealthy()).resolves.toBe(false);
  });

  it('does not flap: repeated checks on an idle manager stay healthy', async () => {
    const m = makeManager();
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await m.isHealthy());
    expect(results).toEqual([true, true, true, true, true]);
  });
});

describe('service-monitor does not restart an idle VirtualGPUManager', () => {
  it('monitorServices() leaves an idle manager alone for several ticks', async () => {
    jest.resetModules();
    const serviceMonitor = require('../../src/core/service-monitor');
    const m = makeManager();
    const initialize = jest.fn().mockResolvedValue(undefined);
    m.initialize = initialize;

    serviceMonitor.setServices({ VirtualGPUManager: m });
    for (let i = 0; i < 3; i++) await serviceMonitor.monitorServices();

    expect(initialize).not.toHaveBeenCalled();
  });
});
