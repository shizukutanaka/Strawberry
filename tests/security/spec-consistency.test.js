// §2: 申告スペック vs ベンチマーク実測の乖離スコア（spec-consistency）テスト。
const { scoreSpecConsistency } = require('../../src/security/spec-consistency');

const CLAIMED = {
  model: 'NVIDIA RTX 4090', vendor: 'NVIDIA', memoryGB: 24, clockMHz: 2520,
  performance: { teraflops: 82.6, benchmarkScore: 34000 },
};

describe('scoreSpecConsistency (§2)', () => {
  it('returns null when no measured report or no comparable metrics', () => {
    expect(scoreSpecConsistency(CLAIMED, null)).toBeNull();
    expect(scoreSpecConsistency(CLAIMED, {})).toBeNull();
  });

  it('scores a faithful listing as consistent', () => {
    const r = scoreSpecConsistency(CLAIMED, {
      model: 'RTX 4090', memoryGB: 24, teraflops: 80, benchmarkScore: 33500,
      clockMHz: 2500, signature: 'sig-abcdef',
    });
    expect(r.label).toBe('consistent');
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('flags over-reported specs (spoof direction) heavily', () => {
    // 安価な RTX 3060 を 4090 と偽ったケース
    const r = scoreSpecConsistency(CLAIMED, {
      model: 'RTX 3060', memoryGB: 12, teraflops: 12.7, benchmarkScore: 17000,
      clockMHz: 1780, signature: 'sig-abcdef',
    });
    expect(r.label).toBe('suspicious');
    expect(r.score).toBeLessThan(0.5);
    expect(r.findings.some(f => f.includes('model mismatch'))).toBe(true);
    expect(r.findings.some(f => f.includes('over-reported'))).toBe(true);
  });

  it('treats under-reporting (measured > claimed) more leniently than over-reporting', () => {
    const over = scoreSpecConsistency(CLAIMED, { teraflops: 60, signature: 's' });
    const under = scoreSpecConsistency(CLAIMED, { teraflops: 110, signature: 's' });
    // 同じ絶対偏差でも over（過申告）の方がスコアが低い
    expect(over.deviations.teraflops.direction).toBe('over');
    expect(under.deviations.teraflops.direction).toBe('under');
    expect(over.score).toBeLessThan(under.score);
  });

  it('notes unsigned reports as informational', () => {
    const r = scoreSpecConsistency(CLAIMED, { teraflops: 82 });
    expect(r.findings.some(f => f.includes('unsigned'))).toBe(true);
  });

  it('detects stale reports', () => {
    const r = scoreSpecConsistency(CLAIMED, {
      teraflops: 82, signature: 'sig-abcdef',
      timestamp: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    });
    expect(r.findings.some(f => f.includes('stale'))).toBe(true);
  });
});
