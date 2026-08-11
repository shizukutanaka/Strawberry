// tests/gpu/gpu-detector-windows-wmic.test.js
//
// Regression: AMD/Intel GPU detection on Windows shelled out to
//
//   wmic path Win32_VideoController where "AdapterCompatibility like '%AMD%'..." get * /format:csv
//
// `wmic` is a deprecated component that is NOT present by default on Windows 11
// (confirmed on this machine: `which wmic` -> not found). Every call therefore
// rejected with "Command failed: wmic ...", was swallowed by the catch, and the
// detector silently reported ZERO AMD and ZERO Intel GPUs on any modern Windows
// host — a marketplace node with an AMD GPU could never list it. The live
// server logged the failure on every startup:
//
//   error: Windows AMD GPU detection error: Command failed: wmic path Win32_VideoController ...
//
// Fix: queryWindowsVideoControllers() now prefers `powershell Get-CimInstance
// Win32_VideoController | ConvertTo-Json` (available wmic-less), keeping wmic
// only as a backward-compatible fallback for older Windows.
//
// Secondary defect also fixed: the old CSV parser split every line on ',' with
// no quote handling, so any property containing a comma shifted all subsequent
// columns. JSON has no such failure mode.

const path = require('path');

const DETECTOR_PATH = path.resolve(__dirname, '../../src/core/gpu-detector-extended.js');

describe('Windows GPU detection no longer depends on wmic', () => {
  it('source: no exec() call issues a vendor-filtered wmic query', () => {
    const src = require('fs').readFileSync(DETECTOR_PATH, 'utf-8');
    // Strip comments first — this file *documents* the old command in prose,
    // and a naive source grep would match that description forever.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/wmic path Win32_VideoController where/);
    // Sanity: the comment-stripper must not have eaten the whole file.
    expect(code).toMatch(/class ExtendedGPUDetector/);
  });

  it('source: PowerShell Get-CimInstance is used as the primary query', () => {
    const src = require('fs').readFileSync(DETECTOR_PATH, 'utf-8');
    expect(src).toMatch(/Get-CimInstance Win32_VideoController/);
    expect(src).toMatch(/ConvertTo-Json/);
  });

  it('detection funnels through the single queryWindowsVideoControllers() helper', () => {
    const { ExtendedGPUDetector } = require(DETECTOR_PATH);
    const d = new ExtendedGPUDetector();
    expect(typeof d.queryWindowsVideoControllers).toBe('function');
    expect(typeof d.detectWindowsGPUsByVendor).toBe('function');
  });
});

describe('vendor filtering over a stubbed controller list', () => {
  const { ExtendedGPUDetector } = require(DETECTOR_PATH);

  function detectorWithControllers(controllers) {
    const d = new ExtendedGPUDetector();
    d.queryWindowsVideoControllers = jest.fn().mockResolvedValue(controllers);
    return d;
  }

  const AMD = {
    Name: 'AMD Radeon RX 7900 XTX',
    DeviceID: 'VideoController1',
    AdapterRAM: 24 * 1024 * 1024 * 1024,
    DriverVersion: '31.0.24027.1012',
    DriverDate: '20240101',
    AdapterCompatibility: 'Advanced Micro Devices, Inc.',
  };
  const NVIDIA = {
    Name: 'NVIDIA RTX A2000 12GB',
    DeviceID: 'VideoController2',
    AdapterRAM: 12 * 1024 * 1024 * 1024,
    DriverVersion: '32.0.16.1088',
    AdapterCompatibility: 'NVIDIA',
  };
  const INTEL_ARC = {
    Name: 'Intel(R) Arc(TM) A770 Graphics',
    DeviceID: 'VideoController3',
    AdapterRAM: 16 * 1024 * 1024 * 1024,
    DriverVersion: '31.0.101.5333',
    AdapterCompatibility: 'Intel Corporation',
  };

  it('detects an AMD card and ignores non-AMD ones', async () => {
    const d = detectorWithControllers([AMD, NVIDIA]);
    const gpus = await d.detectAMDGPUsWindows();
    expect(gpus).toHaveLength(1);
    expect(gpus[0].vendor).toBe('AMD');
    expect(gpus[0].name).toBe(AMD.Name);
    expect(gpus[0].uuid).toBe('AMD-Win-VideoController1');
    expect(gpus[0].vram).toBeGreaterThan(0);
    expect(gpus[0].driver.version).toBe(AMD.DriverVersion);
  });

  it('matches AMD by adapter name too (AdapterCompatibility can say "Radeon")', async () => {
    const d = detectorWithControllers([
      { ...AMD, AdapterCompatibility: '', Name: 'Radeon RX 6800' },
    ]);
    await expect(d.detectAMDGPUsWindows()).resolves.toHaveLength(1);
  });

  it('detects a discrete Intel Arc card', async () => {
    const d = detectorWithControllers([INTEL_ARC, NVIDIA]);
    const gpus = await d.detectIntelGPUsWindows();
    expect(gpus).toHaveLength(1);
    expect(gpus[0].vendor).toBe('Intel');
    expect(gpus[0].capabilities.quickSync).toBe(true);
  });

  it('returns an empty list (not an error) when no matching vendor is present', async () => {
    const d = detectorWithControllers([NVIDIA]);
    await expect(d.detectAMDGPUsWindows()).resolves.toEqual([]);
    await expect(d.detectIntelGPUsWindows()).resolves.toEqual([]);
  });

  it('survives a controller entry with no Name', async () => {
    const d = detectorWithControllers([{ DeviceID: 'x' }, AMD]);
    await expect(d.detectAMDGPUsWindows()).resolves.toHaveLength(1);
  });
});

describe('queryWindowsVideoControllers() runs for real on this host', () => {
  // Guard so the suite stays meaningful on Linux CI.
  const maybe = process.platform === 'win32' ? it : it.skip;

  maybe('returns at least one controller without shelling out to wmic', async () => {
    const { ExtendedGPUDetector } = require(DETECTOR_PATH);
    const d = new ExtendedGPUDetector();
    const controllers = await d.queryWindowsVideoControllers();
    expect(Array.isArray(controllers)).toBe(true);
    expect(controllers.length).toBeGreaterThan(0);
    expect(typeof controllers[0].Name).toBe('string');
    expect(controllers[0].Name.length).toBeGreaterThan(0);
  }, 30000);
});
