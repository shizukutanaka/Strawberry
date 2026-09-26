// §11: 決定論的実行モード — 注文の deterministicExecution が vGPU 割当に伝播し、
// コンテナ（docker/k8s）生成時に再現性 env が注入される契約のテスト。
const { VirtualGPUManager } = require('../../virtual-gpu-manager');

function mgr() {
  const m = Object.create(VirtualGPUManager.prototype);
  m.virtualGPUs = new Map();
  m.allocations = new Map();
  m.containers = new Map();
  m.platform = 'native'; // ローカル検出不要の経路を使う（marketplace GPU = 遅延登録）
  return m;
}

const GPU = { id: 'gpu-1', name: 'RTX 4090', memoryGB: 24 };

describe('deterministic execution (§11)', () => {
  it('allocateGPU stores deterministic config and reports it in the allocation', async () => {
    const m = mgr();
    m.allocateVirtualGPU = async (gpuId, rentalId) => ({ id: 'alloc-1', vgpuId: gpuId, rentalId, status: 'active' });
    const res = await m.allocateGPU('gpu-1', 'order-1', GPU, { deterministic: true });
    expect(res.success).toBe(true);
    expect(res.deterministic).toBe(true);
    expect(m.virtualGPUs.get('gpu-1').config.deterministic).toBe(true);
  });

  it('defaults to non-deterministic when the flag is absent', async () => {
    const m = mgr();
    m.allocateVirtualGPU = async () => ({ id: 'alloc-1', status: 'active' });
    const res = await m.allocateGPU('gpu-1', 'order-1', GPU);
    expect(res.deterministic).toBe(false);
    expect(m.virtualGPUs.get('gpu-1').config.deterministic).toBe(false);
  });

  it('upgrades an already-registered vGPU entry to deterministic', async () => {
    const m = mgr();
    m.allocateVirtualGPU = async () => ({ id: 'a', status: 'active' });
    await m.allocateGPU('gpu-1', 'o1', GPU); // 非決定的に先に登録
    await m.allocateGPU('gpu-1', 'o2', GPU, { deterministic: true });
    expect(m.virtualGPUs.get('gpu-1').config.deterministic).toBe(true);
  });

  it('docker container config injects reproducibility env vars when deterministic', async () => {
    const m = mgr();
    m.platform = 'docker';
    let captured = null;
    m.docker = {
      createContainer: async (cfg) => { captured = cfg; return { id: 'c1', start: async () => {} }; },
    };
    m.getGPUIndex = () => 0;
    const fs = require('fs').promises;
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    await m.createDockerVirtualGPU({ id: 'phys-1', name: 'RTX 4090', model: { series: 'RTX' } }, { deterministic: true }, 'vgpu-x');
    fs.mkdir.mockRestore();
    expect(captured.Env).toContain('CUBLAS_WORKSPACE_CONFIG=:4096:8');
    expect(captured.Env).toContain('NVIDIA_TF32_OVERRIDE=0');
    expect(captured.Env).toContain('PYTHONHASHSEED=0');
    expect(captured.Env).toContain('STRAWBERRY_DETERMINISTIC=1');
  });

  it('docker container config omits deterministic env when not requested', async () => {
    const m = mgr();
    m.platform = 'docker';
    let captured = null;
    m.docker = {
      createContainer: async (cfg) => { captured = cfg; return { id: 'c1', start: async () => {} }; },
    };
    m.getGPUIndex = () => 0;
    const fs = require('fs').promises;
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    await m.createDockerVirtualGPU({ id: 'phys-1', name: 'RTX 4090', model: { series: 'RTX' } }, {}, 'vgpu-y');
    fs.mkdir.mockRestore();
    expect(captured.Env.some((e) => e.startsWith('CUBLAS_WORKSPACE_CONFIG'))).toBe(false);
    expect(captured.Env.some((e) => e.startsWith('STRAWBERRY_DETERMINISTIC'))).toBe(false);
  });
});
