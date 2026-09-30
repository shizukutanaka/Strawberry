// tests/core/gpu-detector-extended.test.js
// ExtendedGPUDetector: /gpus/system/detected が呼ぶ detectAllGPUs の存在と
// ROCm/sysfs 二重列挙の busId 重複排除を検証する。
const { ExtendedGPUDetector } = require('../../src/core/gpu-detector-extended');

describe('ExtendedGPUDetector.detectAllGPUs', () => {
  it('exists and merges AMD + Intel results (route /gpus/system/detected contract)', async () => {
    const d = new ExtendedGPUDetector();
    d.detectAMDGPUsAdvanced = async () => [{ uuid: 'AMD-ROCm-0', vendor: 'AMD', busId: '0000:03:00.0' }];
    d.detectIntelGPUsAdvanced = async () => [{ uuid: 'Intel-card0', vendor: 'Intel', busId: '0000:00:02.0' }];
    const all = await d.detectAllGPUs();
    expect(all).toHaveLength(2);
    expect(all.map((g) => g.vendor).sort()).toEqual(['AMD', 'Intel']);
  });

  it('returns [] when no GPUs are detected on either vendor path', async () => {
    const d = new ExtendedGPUDetector();
    d.detectAMDGPUsAdvanced = async () => [];
    d.detectIntelGPUsAdvanced = async () => [];
    expect(await d.detectAllGPUs()).toEqual([]);
  });
});

describe('ExtendedGPUDetector busId dedup', () => {
  // ROCm と sysfs が同一カードを異なる uuid で列挙するケース:
  // 同一 PCI busId の GPU は1件に絞られる（検出結果二重計上の防止）。
  it('dedupes AMD GPUs sharing the same PCI busId across detection paths', async () => {
    const d = new ExtendedGPUDetector();
    d.platform = 'linux';
    d.checkROCmInstallation = async () => true;
    d.detectROCmGPUs = async () => [
      { uuid: 'AMD-ROCm-0', vendor: 'AMD', busId: '0000:03:00.0' },
    ];
    // sysfs 側が同一物理カードを別 uuid で拾う
    d.detectAMDGPUDriver = async () => [
      { uuid: 'AMD-card0', vendor: 'AMD', busId: '0000:03:00.0' },
      { uuid: 'AMD-card1', vendor: 'AMD', busId: '0000:41:00.0' },
    ];
    const gpus = await d.detectAMDGPUsAdvanced();
    expect(gpus).toHaveLength(2);
    expect(gpus.map((g) => g.uuid)).toEqual(['AMD-ROCm-0', 'AMD-card1']);
  });

  it('keeps entries whose busId is unknown (no accidental drop)', async () => {
    const d = new ExtendedGPUDetector();
    d.platform = 'linux';
    d.checkROCmInstallation = async () => false;
    d.detectAMDGPUDriver = async () => [
      { uuid: 'AMD-card0', vendor: 'AMD' },
      { uuid: 'AMD-card1', vendor: 'AMD' },
    ];
    const gpus = await d.detectAMDGPUsAdvanced();
    expect(gpus).toHaveLength(2);
  });
});

describe('ExtendedGPUDetector detail/benchmark placeholders', () => {
  // 旧実装は stdout を捨てるだけの rocm-bandwidth-test / ze_peak / level-zero-info /
  // rocm-smi --showproductname を検出ごとに実行していた（テナント帯域を占有する実害）。
  it('benchmark/detail methods return zeroed placeholders without shelling out', async () => {
    const d = new ExtendedGPUDetector();
    const gpu = { uuid: 'AMD-ROCm-0', capabilities: { rocm: true, levelZero: true } };
    await expect(d.benchmarkAMDGPU(gpu)).resolves.toEqual({
      computeScore: 0, memoryBandwidth: 0, powerEfficiency: 0,
    });
    await expect(d.benchmarkIntelGPU(gpu)).resolves.toEqual({
      computeScore: 0, memoryBandwidth: 0, quickSyncScore: 0,
    });
    await expect(d.getAMDGPUDetails(gpu)).resolves.toMatchObject({ computeUnits: 0 });
    await expect(d.getIntelGPUDetails(gpu)).resolves.toMatchObject({ euCount: 0 });
  });
});
