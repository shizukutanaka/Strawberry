// tests/gpu/gpu-auto-heal.test.js — GpuAutoHealer の修復契約をユニットテストで固定。
// virtual-gpu-manager は本番ではプラットフォーム実体（k8s/docker/native）を叩くため、
// ここでは公開 API 面（virtualGPUs/allocations Map と async メソッド群）だけを持つ
// フェイクを注入し、release→destroy→再作成→再割当の順序と諦め・掃除の契約を検証する。

jest.mock('../../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { GpuAutoHealer, startGpuAutoHeal } = require('../../src/gpu/gpu-auto-heal');
const { logger } = require('../../src/core/logger');

function makeManager() {
  const mgr = {
    virtualGPUs: new Map(),
    allocations: new Map(),
    calls: { probed: [], released: [], destroyed: [], created: [], allocated: [] },
    failProbe: false,
    failProbeIds: null,
    failDestroy: false,
    failRelease: false,
    async getVirtualGPUStats(id) {
      this.calls.probed.push(id);
      if (this.failProbe || (this.failProbeIds && this.failProbeIds.has(id))) throw new Error('pod unreachable');
      return { vramUsed: 1 };
    },
    async releaseVirtualGPU(id) {
      if (this.failRelease) throw new Error('teardown failed');
      this.calls.released.push(id);
      const a = this.allocations.get(id);
      if (a) a.status = 'released';
      const v = this.virtualGPUs.get(a.vgpuId);
      if (v) v.status = 'available';
      return a;
    },
    async destroyVirtualGPU(id) {
      this.calls.destroyed.push(id);
      if (this.failDestroy) throw new Error('Cannot destroy allocated virtual GPU');
      this.virtualGPUs.delete(id);
    },
    async createVirtualGPU(physicalGPU, config) {
      const v = { id: `vgpu-new-${this.calls.created.length}`, physicalGPUId: physicalGPU.id, config, status: 'available' };
      this.calls.created.push({ physicalGPUId: physicalGPU.id, config });
      this.virtualGPUs.set(v.id, v);
      return v;
    },
    async allocateVirtualGPU(vgpuId, rentalId) {
      this.calls.allocated.push({ vgpuId, rentalId });
      const a = { id: `alloc-new-${this.calls.allocated.length}`, vgpuId, rentalId, status: 'active' };
      this.allocations.set(a.id, a);
      return a;
    },
  };
  return mgr;
}

function addVgpu(mgr, id, { status = 'allocated', physicalGPUId = 'phys-1', config = { vram: 8 } } = {}) {
  const vgpu = { id, physicalGPUId, config, status };
  mgr.virtualGPUs.set(id, vgpu);
  return vgpu;
}

function addAllocation(mgr, { id, vgpuId, rentalId = 'rental-1', status = 'active' }) {
  const a = { id, vgpuId, rentalId, status };
  mgr.allocations.set(id, a);
  return a;
}

function makeHealer(mgr, extra = {}) {
  return new GpuAutoHealer({
    vgpuManager: mgr,
    gpuRepository: { getById: (id) => (id === 'phys-1' ? { id: 'phys-1', name: 'RTX' } : null) },
    intervalMs: 0,
    failureThreshold: 2,
    ...extra,
  });
}

describe('GpuAutoHealer constructor', () => {
  it('requires a vgpuManager', () => {
    expect(() => new GpuAutoHealer({})).toThrow('vgpuManager');
  });
});

describe('probe + failure counting', () => {
  it('does nothing while instances stay healthy', async () => {
    const mgr = makeManager();
    addVgpu(mgr, 'v1');
    const h = makeHealer(mgr);
    await h.tick();
    expect(mgr.calls.probed).toEqual(['v1']);
    expect(mgr.calls.destroyed).toEqual([]);
    expect(h._state.size).toBe(0);
  });

  it('heals only after failureThreshold consecutive failures', async () => {
    const mgr = makeManager();
    mgr.failProbe = true;
    addVgpu(mgr, 'v1');
    const h = makeHealer(mgr, { failureThreshold: 2 });

    await h.tick(); // 1st failure
    expect(mgr.calls.destroyed).toEqual([]);
    await h.tick(); // 2nd failure -> heal
    expect(mgr.calls.destroyed).toEqual(['v1']);
  });

  it('resets the counter when a probe succeeds again', async () => {
    const mgr = makeManager();
    addVgpu(mgr, 'v1');
    const h = makeHealer(mgr, { failureThreshold: 2 });

    mgr.failProbe = true;
    await h.tick();
    mgr.failProbe = false;
    await h.tick();
    mgr.failProbe = true;
    await h.tick(); // only 1 consecutive failure — no heal
    expect(mgr.calls.destroyed).toEqual([]);
  });

  it('prunes state entries for vgpus that vanished', async () => {
    const mgr = makeManager();
    mgr.failProbe = true;
    addVgpu(mgr, 'v1');
    const h = makeHealer(mgr, { failureThreshold: 5 });
    await h.tick();
    expect(h._state.has('v1')).toBe(true);

    mgr.virtualGPUs.delete('v1');
    await h.tick();
    expect(h._state.has('v1')).toBe(false);
  });
});

describe('heal flow: release → destroy → recreate → reschedule', () => {
  it('releases active allocations before destroying and reschedules them on the new instance', async () => {
    const mgr = makeManager();
    mgr.failProbe = true;
    const vgpu = addVgpu(mgr, 'v1', { config: { vram: 16 } });
    addAllocation(mgr, { id: 'a1', vgpuId: 'v1', rentalId: 'rental-A' });
    addAllocation(mgr, { id: 'a2', vgpuId: 'v1', rentalId: 'rental-B' });
    const h = makeHealer(mgr);

    await h.tick();
    await h.tick();

    expect(mgr.calls.released.sort()).toEqual(['a1', 'a2']);
    expect(mgr.calls.destroyed).toEqual(['v1']);
    expect(mgr.calls.created).toEqual([{ physicalGPUId: 'phys-1', config: { vram: 16 } }]);
    expect(mgr.calls.allocated).toEqual([
      { vgpuId: 'vgpu-new-0', rentalId: 'rental-A' },
      { vgpuId: 'vgpu-new-0', rentalId: 'rental-B' },
    ]);
    expect(vgpu.physicalGPUId).toBe('phys-1');
  });

  it('ignores allocations on other vgpus and non-active ones', async () => {
    const mgr = makeManager();
    mgr.failProbeIds = new Set(['v1']);
    addVgpu(mgr, 'v1');
    addVgpu(mgr, 'v2');
    addAllocation(mgr, { id: 'a1', vgpuId: 'v1', rentalId: 'r1' });
    addAllocation(mgr, { id: 'a2', vgpuId: 'v2', rentalId: 'r2' });
    addAllocation(mgr, { id: 'a3', vgpuId: 'v1', rentalId: 'r3', status: 'released' });
    const h = makeHealer(mgr);

    await h.tick();
    await h.tick();

    expect(mgr.calls.released).toEqual(['a1']);
    expect(mgr.calls.allocated).toEqual([{ vgpuId: 'vgpu-new-0', rentalId: 'r1' }]);
  });

  it('gives up and warns when destroy is refused (manual intervention)', async () => {
    const mgr = makeManager();
    mgr.failProbe = true;
    mgr.failDestroy = true;
    addVgpu(mgr, 'v1');
    const h = makeHealer(mgr);

    await h.tick();
    await h.tick(); // heal attempted, destroy refused
    expect(mgr.calls.destroyed).toEqual(['v1']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('manual intervention'));

    mgr.calls.probed = [];
    await h.tick(); // gaveUp — no more probes for v1
    expect(mgr.calls.probed).toEqual([]);
  });

  it('does not recreate when the physical GPU record is gone', async () => {
    const mgr = makeManager();
    mgr.failProbe = true;
    addVgpu(mgr, 'v1', { physicalGPUId: 'phys-gone' });
    const h = makeHealer(mgr);

    await h.tick();
    await h.tick();

    expect(mgr.calls.destroyed).toEqual(['v1']);
    expect(mgr.calls.created).toEqual([]);
    expect(h._state.has('v1')).toBe(false);
  });
});

describe('timer contract', () => {
  it('does not start when intervalMs <= 0 (opt-in)', () => {
    const h = makeHealer(makeManager(), { intervalMs: 0, allowInTest: true });
    h.start();
    expect(h._timer).toBeNull();
  });

  it('is suppressed in NODE_ENV=test unless allowInTest', () => {
    const h = makeHealer(makeManager(), { intervalMs: 60_000, allowInTest: false });
    h.start();
    expect(h._timer).toBeNull();
  });

  it('creates an unrefed interval and is re-init safe', () => {
    const h = makeHealer(makeManager(), { intervalMs: 60_000, allowInTest: true });
    h.start();
    expect(h._timer).not.toBeNull();
    expect(h._timer.hasRef()).toBe(false);
    const first = h._timer;
    h.start(); // no-op
    expect(h._timer).toBe(first);
    h.stop();
    expect(h._timer).toBeNull();
  });

  it('tick does not overlap itself', async () => {
    const mgr = makeManager();
    addVgpu(mgr, 'v1');
    let resolveProbe;
    mgr.getVirtualGPUStats = () => new Promise((r) => { resolveProbe = r; });
    const h = makeHealer(mgr);

    const t1 = h.tick();
    await h.tick(); // second call returns early while t1 in flight
    expect(mgr.calls.probed.length <= 1).toBe(true);
    resolveProbe({});
    await t1;
  });
});

describe('startGpuAutoHeal env wiring', () => {
  const envBackup = { ...process.env };
  afterEach(() => { process.env = { ...envBackup }; });

  it('is opt-in: does not start without GPU_AUTO_HEAL_INTERVAL_MS', () => {
    delete process.env.GPU_AUTO_HEAL_INTERVAL_MS;
    const h = startGpuAutoHeal(makeManager(), { allowInTest: true });
    expect(h._timer).toBeNull();
  });

  it('honours GPU_AUTO_HEAL_INTERVAL_MS and GPU_AUTO_HEAL_FAILURE_THRESHOLD', () => {
    process.env.GPU_AUTO_HEAL_INTERVAL_MS = '60000';
    process.env.GPU_AUTO_HEAL_FAILURE_THRESHOLD = '5';
    const h = startGpuAutoHeal(makeManager(), { allowInTest: true });
    expect(h._timer).not.toBeNull();
    expect(h.failureThreshold).toBe(5);
    h.stop();
  });
});
