// VirtualGPUManager のルート互換 API 契約テスト
//
// 背景: src/api/routes/{gpu,order} は vgpuManager.allocateGPU / releaseGPU /
// getGPUUsageStats / getGPUDetails / getGPUAvailability / getGPUBenchmarkResults /
// runGPUBenchmark を呼ぶが、クラス本来の API 名は allocateVirtualGPU /
// releaseVirtualGPU / getVirtualGPUStats だった。名前・シグネチャの差異で vgpu 有効時に
// 必ず TypeError になり、レンタル開始/終了フローが壊れていた。互換メソッドの存在と
// allocate→release のラウンドトリップ（{success} 返却・gpuId 起点の解放）を固定する。
const { VirtualGPUManager } = require('../../virtual-gpu-manager');

describe('VirtualGPUManager route-compat API', () => {
  const required = [
    'allocateGPU', 'releaseGPU', 'getGPUUsageStats',
    'getGPUDetails', 'getGPUAvailability', 'getGPUBenchmarkResults', 'runGPUBenchmark'
  ];

  it('exposes all method names the routes call', () => {
    for (const name of required) {
      expect(typeof VirtualGPUManager.prototype[name]).toBe('function');
    }
  });

  it('allocateGPU returns {success:false} instead of throwing for unknown GPU', async () => {
    const mgr = Object.create(VirtualGPUManager.prototype);
    mgr.virtualGPUs = new Map();
    mgr.allocations = new Map();
    const res = await mgr.allocateGPU('no-such-gpu', 'rental-1');
    expect(res.success).toBe(false);
    expect(typeof res.message).toBe('string');
  });

  it('allocateGPU/releaseGPU round-trip on a stubbed available GPU', async () => {
    const mgr = Object.create(VirtualGPUManager.prototype);
    mgr.platform = 'unknown'; // switch 文が no-op になりプラットフォーム I/O を回避
    mgr.virtualGPUs = new Map([['gpu-1', { id: 'gpu-1', status: 'available' }]]);
    mgr.allocations = new Map();
    mgr.generateAccessInfo = async () => ({});
    mgr.emit = () => {};

    const alloc = await mgr.allocateGPU('gpu-1', 'rental-1');
    expect(alloc.success).toBe(true);
    expect(mgr.virtualGPUs.get('gpu-1').status).toBe('allocated');

    // releaseGPU は gpuId 起点で割り当てを解決できること
    mgr.releaseVirtualGPU = async (allocationId) => {
      const a = mgr.allocations.get(allocationId);
      a.status = 'released';
      mgr.virtualGPUs.get(a.vgpuId).status = 'available';
      return a;
    };
    await mgr.releaseGPU('gpu-1', 'rental-1');
    expect(mgr.virtualGPUs.get('gpu-1').status).toBe('available');
  });

  it('allocateVirtualGPU rolls back status to available on setup failure', async () => {
    const mgr = Object.create(VirtualGPUManager.prototype);
    mgr.platform = 'docker';
    mgr.virtualGPUs = new Map([['gpu-2', { id: 'gpu-2', status: 'available' }]]);
    mgr.allocations = new Map();
    mgr.generateAccessInfo = async () => ({});
    mgr.setupDockerAccess = async () => { throw new Error('docker down'); };
    mgr.emit = () => {};

    await expect(mgr.allocateVirtualGPU('gpu-2', 'rental-2')).rejects.toThrow('docker down');
    // ロールバックされ、再確保可能であること（TOCTOU ガードが残留しない）
    expect(mgr.virtualGPUs.get('gpu-2').status).toBe('available');
  });
});
