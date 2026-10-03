// VirtualGPUManager.getMetricsSnapshot() と /metrics 公開メトリクスの回帰テスト。
// チェックリスト「仮想GPUの運用監視（リソース使用率・割当状況等）の可視化」対応:
// vGPU インスタンス数（status 別）と active アロケーション数を Prometheus gauge
// として公開する。スナップショットは Map の集計のみで外部 I/O を持たない。
const request = require('supertest');
const { VirtualGPUManager } = require('../../virtual-gpu-manager');
const { app } = require('../../src/api/server');

function makeManager(virtualGPUs, allocations) {
  const mgr = Object.create(VirtualGPUManager.prototype);
  mgr.virtualGPUs = new Map(virtualGPUs);
  mgr.allocations = new Map(allocations);
  return mgr;
}

describe('VirtualGPUManager.getMetricsSnapshot', () => {
  it('status 別の vGPU 数と active アロケーション数を集計する', () => {
    const mgr = makeManager(
      [
        ['gpu-1', { id: 'gpu-1', status: 'available' }],
        ['gpu-2', { id: 'gpu-2', status: 'allocated' }],
        ['gpu-3', { id: 'gpu-3', status: 'allocated' }],
      ],
      [
        ['a-1', { status: 'active' }],
        ['a-2', { status: 'released' }],
        ['a-3', { status: 'active' }],
      ],
    );
    expect(mgr.getMetricsSnapshot()).toEqual({
      byStatus: { available: 1, allocated: 2 },
      activeAllocations: 2,
    });
  });

  it('空プールでは空集計を返す', () => {
    const mgr = makeManager([], []);
    expect(mgr.getMetricsSnapshot()).toEqual({ byStatus: {}, activeAllocations: 0 });
  });

  it('status 欠落エントリは unknown として数える', () => {
    const mgr = makeManager([['gpu-1', { id: 'gpu-1' }]], []);
    expect(mgr.getMetricsSnapshot().byStatus).toEqual({ unknown: 1 });
  });
});

describe('/metrics の vGPU メトリクス公開', () => {
  it('vgpu_allocations_active gauge が出力に含まれる', async () => {
    const res = await request(app).get('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('vgpu_allocations_active');
  });
});
