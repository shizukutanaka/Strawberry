// §12 DLPerf-equivalent standard score — unit tests for the pure scoring layer.
const { standardScore, normalizeModelKey, REFERENCE_GPUS } = require('../../src/marketplace/dlperf-score');

describe('dlperf-score (standard GPU score)', () => {
  it('normalizes RTX 4090 to 1.000', () => {
    const s = standardScore({ model: 'RTX 4090' });
    expect(s.score).toBeCloseTo(1.0, 3);
    expect(s.matchedModel).toBe('RTX 4090');
    expect(s.source).toBe('reference-table');
  });

  it('ranks datacenter GPUs above consumer ones (H100 > A100 > 4090 > 3090)', () => {
    const h100 = standardScore({ model: 'NVIDIA H100 PCIe' }).score;
    const a100 = standardScore({ model: 'NVIDIA A100' }).score;
    const rtx4090 = standardScore({ model: 'GeForce RTX 4090' }).score;
    const rtx3090 = standardScore({ model: 'RTX-3090' }).score;
    expect(h100).toBeGreaterThan(a100);
    expect(a100).toBeGreaterThan(rtx4090);
    expect(rtx4090).toBeGreaterThan(rtx3090);
  });

  it('matches noisy provider-claimed model strings via normalization/substring', () => {
    expect(standardScore({ model: 'NVIDIA GeForce RTX 4090 OC Edition' }).score).toBeCloseTo(1.0, 2);
    expect(standardScore({ model: 'nvidia-a100-sxm4-80gb' }).score).toBeGreaterThan(1);
    expect(standardScore({ name: 'Tesla T4' }).score).toBeGreaterThan(0);
  });

  it('prefers longer keys on substring match (3090 Ti ≠ 3090)', () => {
    const ti = standardScore({ model: 'RTX 3090 Ti' }).score;
    const base = standardScore({ model: 'RTX 3090' }).score;
    expect(ti).not.toBe(base);
    expect(ti).toBeGreaterThan(base);
  });

  it('returns null for unknown models and never trusts self-reported fields', () => {
    // 自己申告スコアを水増ししても参照テーブル由来のスコアは変わらない
    const s = standardScore({ model: 'Mystery GPU 9000', performance: { benchmarkScore: 9999999 } });
    expect(s.score).toBeNull();
    expect(s.source).toBeNull();
    expect(standardScore({ model: null }).score).toBeNull();
    expect(standardScore({}).score).toBeNull();
  });

  it('normalization is deterministic and prefix-insensitive', () => {
    expect(normalizeModelKey('NVIDIA GeForce RTX 4090')).toBe('rtx4090');
    expect(normalizeModelKey('AMD Radeon MI100')).toBe('mi100');
    expect(normalizeModelKey(42)).toBe('');
  });

  it('reference table has unique keys and sane spec values', () => {
    const seen = new Set();
    for (const r of REFERENCE_GPUS) {
      for (const k of r.keys) {
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
      expect(r.fp16).toBeGreaterThan(0);
      expect(r.bw).toBeGreaterThan(0);
    }
  });
});
