// tests/gpu/listing-defaults.test.js
// 出品の必須項目を 5 つに絞り、残りを機種から導出する部分。
// 実サーバで「貸し手が自然に答えられる項目だけでは出品が 400 になる」ことを
// 確認したのが発端。供給側が登録できない市場は成立しないので、ここは製品の
// 入口にあたる。
const { applyListingDefaults, lookupTdpWatt, VENDOR_API, DEFAULT_ARCH } = require('../../src/gpu/listing-defaults');

const MINIMAL = Object.freeze({
  name: 'My 4090 box', vendor: 'NVIDIA', model: 'GeForce RTX 4090',
  memoryGB: 24, pricePerHour: 120000,
});

describe('lookupTdpWatt', () => {
  it('resolves the catalogue TDP from a messy model string', () => {
    expect(lookupTdpWatt('NVIDIA GeForce RTX 4090')).toBe(450);
    expect(lookupTdpWatt('rtx-4090')).toBe(450);
    expect(lookupTdpWatt('H100 SXM')).toBe(700);
  });

  it('distinguishes SKUs rather than collapsing them', () => {
    // H100 SXM(700W) と PCIe(350W) を同じ扱いにすると、排出量推定が倍ずれる。
    expect(lookupTdpWatt('H100 PCIe')).toBe(350);
    expect(lookupTdpWatt('H100 SXM')).toBe(700);
  });

  it('returns null for an unknown model instead of guessing', () => {
    expect(lookupTdpWatt('Acme Ultra 9000')).toBeNull();
    expect(lookupTdpWatt('')).toBeNull();
    expect(lookupTdpWatt(null)).toBeNull();
  });
});

describe('applyListingDefaults', () => {
  it('fills apiType, arch and powerWatt from a five-field listing', () => {
    const { gpu, derivedFields } = applyListingDefaults(MINIMAL);
    expect(gpu.apiType).toBe('CUDA');
    expect(gpu.arch).toBe(DEFAULT_ARCH);
    expect(gpu.powerWatt).toBe(450);
    expect(derivedFields.sort()).toEqual(['apiType', 'arch', 'powerWatt']);
  });

  it('maps each vendor to its own compute API', () => {
    for (const [vendor, api] of Object.entries(VENDOR_API)) {
      expect(applyListingDefaults({ ...MINIMAL, vendor }).gpu.apiType).toBe(api);
    }
  });

  it('never overrides a value the provider declared', () => {
    const declared = { ...MINIMAL, apiType: 'OpenCL', arch: 'arm64', powerWatt: 300 };
    const { gpu, derivedFields } = applyListingDefaults(declared);
    expect(gpu.apiType).toBe('OpenCL');
    expect(gpu.arch).toBe('arm64');
    expect(gpu.powerWatt).toBe(300);
    expect(derivedFields).toEqual([]);
  });

  it('leaves powerWatt absent for an unknown model rather than inventing one', () => {
    // 推測した消費電力を保存すると、carbon の排出量推定と perf-score の
    // TFLOPS/W 上限がどちらも根拠のない数字の上に乗る。
    const { gpu, derivedFields } = applyListingDefaults({ ...MINIMAL, model: 'Acme Ultra 9000' });
    expect(gpu.powerWatt).toBeUndefined();
    expect(derivedFields).not.toContain('powerWatt');
    expect(derivedFields).toContain('apiType');
  });

  it('treats a zero or non-finite powerWatt as absent, not as a declaration', () => {
    // フォームの空欄が Number('') === 0 で送られてくると「消費電力 0W」という
    // 誤った申告になる。0 は宣言として扱わない。
    for (const bad of [0, NaN, Infinity, null, undefined, '450']) {
      const { gpu } = applyListingDefaults({ ...MINIMAL, powerWatt: bad });
      expect(gpu.powerWatt).toBe(450);
    }
  });

  it('leaves an unknown vendor without an apiType instead of picking one', () => {
    const { gpu, derivedFields } = applyListingDefaults({ ...MINIMAL, vendor: 'Acme' });
    expect(gpu.apiType).toBeUndefined();
    expect(derivedFields).not.toContain('apiType');
  });

  it('does not mutate the input object', () => {
    const input = { ...MINIMAL };
    applyListingDefaults(input);
    expect(input).toEqual(MINIMAL);
  });

  it('passes through unrelated fields untouched', () => {
    const { gpu } = applyListingDefaults({ ...MINIMAL, location: { country: 'JP' }, minRenterRating: 4 });
    expect(gpu.location).toEqual({ country: 'JP' });
    expect(gpu.minRenterRating).toBe(4);
    expect(gpu.pricePerHour).toBe(120000);
  });
});
