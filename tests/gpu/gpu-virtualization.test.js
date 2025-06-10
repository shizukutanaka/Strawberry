// GPU仮想化・リソース割当/解放・競合制御の自動テスト雛形（Jest）
const { VirtualGPUManager } = require('../../src/gpu/gpu-virtualization');

describe('VirtualGPUManager', () => {
  let mgr;
  beforeEach(() => {
    mgr = new VirtualGPUManager();
    mgr.registerPhysicalGPUs([
      { uuid: 'gpu-1' },
      { uuid: 'gpu-2' }
    ]);
  });

  it('空きGPUを割り当てできる', () => {
    const g1 = mgr.allocate('userA');
    expect(g1).toBeTruthy();
    expect(g1.busy).toBe(true);
    expect(g1.assignedTo).toBe('userA');
  });

  it('割当済みGPUは他ユーザーに割当できない', () => {
    mgr.allocate('userA');
    const g2 = mgr.allocate('userB');
    expect(g2).toBeTruthy();
    expect(g2.assignedTo).toBe('userB');
    // もう空きがない
    expect(mgr.allocate('userC')).toBeNull();
  });

  it('releaseでGPUを解放できる', () => {
    const g = mgr.allocate('userA');
    expect(mgr.release(g.uuid)).toBe(true);
    expect(mgr.getAssigned('userA').length).toBe(0);
    expect(mgr.allocate('userB')).toBeTruthy();
  });

  it('getStatusで全GPUの状態を取得', () => {
    mgr.allocate('userA');
    const status = mgr.getStatus();
    expect(status.length).toBe(2);
    expect(status.filter(g => g.busy).length).toBe(1);
  });
});
