// tests/gpu/perf-score.test.js
// 正規化性能スコア（DLPerf 風）の単体テスト。
// 重点は「順位が直感と一致すること」と「自己申告で順位を買えないこと」。
const perf = require('../../src/gpu/perf-score');

const gpu = (over = {}) => ({
  name: 'test', model: 'RTX 4090', memoryGB: 24, powerWatt: 450, pricePerHour: 1000, ...over,
});

describe('normalizeModelName', () => {
  it('strips vendor/marketing words and normalizes separators', () => {
    expect(perf.normalizeModelName('NVIDIA GeForce RTX 4090')).toBe('rtx 4090');
    expect(perf.normalizeModelName('rtx-4090')).toBe('rtx 4090');
    expect(perf.normalizeModelName('RTX4090')).toBe('rtx 4090');
    expect(perf.normalizeModelName('AMD Instinct MI300X')).toBe('mi300x');
  });

  it('does NOT split short series prefixes that are part of the model number', () => {
    // 汎用に [a-z]+\d+ を分割すると 'a100' が 'a 100' になり参照表を引けなくなる回帰
    expect(perf.normalizeModelName('NVIDIA A100 80GB')).toBe('a100 80gb');
    expect(perf.normalizeModelName('H100')).toBe('h100');
  });

  it('is safe on non-string input', () => {
    expect(perf.normalizeModelName(null)).toBe('');
    expect(perf.normalizeModelName(42)).toBe('');
  });
});

describe('lookupModel', () => {
  it('prefers the longest matching key so specific SKUs win', () => {
    expect(perf.lookupModel('NVIDIA A100 80GB').key).toBe('a100 80gb');
    expect(perf.lookupModel('L40S').key).toBe('l40s');
    // 'l40s' が 'l4'/'l40' に食われない
    expect(perf.lookupModel('L4').key).toBe('l4');
  });

  it('matches on word boundaries only', () => {
    expect(perf.lookupModel('SuperL4X9000')).toBeNull();
  });

  it('returns null for unknown models', () => {
    expect(perf.lookupModel('Totally Unknown GPU')).toBeNull();
  });
});

describe('computePerfScore — ranking sanity', () => {
  it('scores the reference GPU at exactly 100', () => {
    expect(perf.computePerfScore(gpu()).score).toBe(100);
  });

  it('orders known datacenter GPUs above consumer GPUs', () => {
    const h100 = perf.computePerfScore(gpu({ model: 'H100 SXM', memoryGB: 80, powerWatt: 700 })).score;
    const a100 = perf.computePerfScore(gpu({ model: 'NVIDIA A100 80GB', memoryGB: 80, powerWatt: 400 })).score;
    const rtx4090 = perf.computePerfScore(gpu()).score;
    const rtx3090 = perf.computePerfScore(gpu({ model: 'RTX 3090' })).score;
    const t4 = perf.computePerfScore(gpu({ model: 'Tesla T4', memoryGB: 16, powerWatt: 70 })).score;
    expect(h100).toBeGreaterThan(a100);
    expect(a100).toBeGreaterThan(rtx4090);
    expect(rtx4090).toBeGreaterThan(rtx3090);
    expect(rtx3090).toBeGreaterThan(t4);
  });

  it('reports reference confidence and the matched model for known GPUs', () => {
    const r = perf.computePerfScore(gpu({ model: 'H100 SXM', memoryGB: 80 }));
    expect(r.confidence).toBe('reference');
    // より具体的な SKU キー（'h100 sxm'）が汎用キー（'h100'）に優先する
    expect(r.matchedModel).toBe('h100 sxm');
    expect(r.basis.source).toBe('model-table:h100 sxm');
    expect(r.findings).toEqual([]);
  });

  it('upgrades confidence to attested when attestation passed', () => {
    const r = perf.computePerfScore(gpu({ attestation: { passed: true } }));
    expect(r.confidence).toBe('attested');
    // スコア値そのものは裏付けの有無で変えない（数値の意味が揺れないようにする）
    expect(r.score).toBe(perf.computePerfScore(gpu()).score);
  });

  it('does not upgrade confidence when attestation failed', () => {
    expect(perf.computePerfScore(gpu({ attestation: { passed: false } })).confidence).toBe('reference');
  });
});

describe('computePerfScore — 詐称・順位買いへの耐性', () => {
  it('refuses the model table when declared VRAM contradicts the model name', () => {
    // 「H100」を名乗る 24GB の出品に H100 のスコアを与えない
    const r = perf.computePerfScore(gpu({ model: 'H100', memoryGB: 24, powerWatt: 250 }));
    expect(r.matchedModel).toBe('h100');
    expect(r.basis.source).toBe('declared(model-table-rejected)');
    expect(r.findings.some((f) => f.startsWith('vram_mismatch'))).toBe(true);
    // 演算性能の根拠が消えるためスコアは算出しない
    expect(r.score).toBeNull();
    expect(r.confidence).toBe('unknown');
  });

  it('flags a declared TFLOPS that contradicts the known model', () => {
    const r = perf.computePerfScore(gpu({ performance: { teraflops: 900 } }));
    expect(r.findings.some((f) => f.startsWith('teraflops_mismatch'))).toBe(true);
    // TFLOPS は測定条件で振れるため、これ単独では参照表を捨てない
    expect(r.basis.source).toBe('model-table:rtx 4090');
    expect(r.score).toBe(100);
  });

  it('clamps a physically impossible declared TFLOPS to the power budget', () => {
    const r = perf.computePerfScore(gpu({ model: 'Mystery X', powerWatt: 300, performance: { teraflops: 50000 } }));
    expect(r.findings.some((f) => f.startsWith('teraflops_implausible'))).toBe(true);
    expect(r.basis.fp16Tflops).toBe(300 * perf.MAX_TFLOPS_PER_WATT);
  });

  it('caps unverified unknown models at the reference score', () => {
    const r = perf.computePerfScore(gpu({ model: 'Mystery X', powerWatt: 300, performance: { teraflops: 50000 } }));
    expect(r.score).toBe(100);
    expect(r.findings.some((f) => f.startsWith('unverified_model_capped'))).toBe(true);
  });

  it('lifts the unknown-model cap once attestation passes', () => {
    const r = perf.computePerfScore(gpu({
      model: 'Mystery X', powerWatt: 300, performance: { teraflops: 50000 }, attestation: { passed: true },
    }));
    expect(r.score).toBeGreaterThan(100);
    expect(r.findings.some((f) => f.startsWith('unverified_model_capped'))).toBe(false);
  });

  it('leaves an honest below-reference declared GPU uncapped', () => {
    const r = perf.computePerfScore(gpu({ model: 'Mystery X', memoryGB: 16, powerWatt: 150, performance: { teraflops: 60 } }));
    expect(r.confidence).toBe('declared');
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(100);
    expect(r.findings).toEqual([]);
  });
});

describe('computePerfScore — 算出不能を推測で埋めない', () => {
  it('returns null for an unknown model with no compute evidence', () => {
    const r = perf.computePerfScore(gpu({ model: 'Unknown 9000', memoryGB: 48 }));
    expect(r.score).toBeNull();
    expect(r.confidence).toBe('unknown');
    expect(r.findings.some((f) => f.startsWith('insufficient_data'))).toBe(true);
  });

  it('does not let VRAM capacity alone produce a high score', () => {
    // 容量だけで H100 級に見える出品を作れてはならない
    expect(perf.computePerfScore(gpu({ model: 'Unknown 9000', memoryGB: 8192 })).score).toBeNull();
  });

  it('is safe on empty / malformed input', () => {
    expect(perf.computePerfScore().score).toBeNull();
    expect(perf.computePerfScore({}).score).toBeNull();
    expect(perf.computePerfScore({ model: 123, performance: 'nope' }).score).toBeNull();
  });
});

describe('perfPerCost', () => {
  it('computes performance per sats/hour', () => {
    expect(perf.perfPerCost(100, 1000)).toBe(0.1);
  });

  it('ranks a cheap mid-range GPU above an overpriced flagship', () => {
    const cheap = perf.perfPerCost(perf.computePerfScore(gpu({ model: 'RTX 3090' })).score, 200);
    const pricey = perf.perfPerCost(perf.computePerfScore(gpu({ model: 'H100 SXM', memoryGB: 80, powerWatt: 700 })).score, 50000);
    expect(cheap).toBeGreaterThan(pricey);
  });

  it('returns null for a missing score or a non-positive price', () => {
    expect(perf.perfPerCost(null, 100)).toBeNull();
    expect(perf.perfPerCost(100, 0)).toBeNull();
    expect(perf.perfPerCost(100, -5)).toBeNull();
  });
});

describe('toPricingFeatures', () => {
  it('bridges a listing record into feature-pricer vocabulary', () => {
    const f = perf.toPricingFeatures(gpu({ model: 'H100 SXM', memoryGB: 80 }));
    expect(f.vramGB).toBe(80);
    expect(f.memBandwidthGBs).toBe(3350);
    expect(f.benchmarkScore).toBeGreaterThan(100);
  });

  it('never overrides explicitly supplied feature-pricer fields', () => {
    const f = perf.toPricingFeatures({ vramGB: 80, memBandwidthGBs: 3350, benchmarkScore: 300, generation: 'hopper' });
    expect(f).toEqual({ vramGB: 80, memBandwidthGBs: 3350, benchmarkScore: 300, generation: 'hopper' });
  });

  it('omits features it cannot justify rather than defaulting them to 0', () => {
    const f = perf.toPricingFeatures({ model: 'Unknown 9000', memoryGB: 48 });
    expect(f.vramGB).toBe(48);
    expect(f.memBandwidthGBs).toBeUndefined();
    expect(f.benchmarkScore).toBeUndefined();
  });
});

describe('summarize', () => {
  it('returns the API/UI-facing shape', () => {
    const s = perf.summarize(gpu({ pricePerHour: 500 }));
    expect(s).toEqual(expect.objectContaining({
      score: 100, confidence: 'reference', matchedModel: 'rtx 4090', perfPerHourSat: 0.2,
    }));
    expect(s.basis).toBeDefined();
    expect(Array.isArray(s.findings)).toBe(true);
  });
});
