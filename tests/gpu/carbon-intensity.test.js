// tests/gpu/carbon-intensity.test.js
// 申告所在地に基づくカーボン強度・排出量推定（研究ドキュメント §15）。
//
// この機能の失敗モードはグリーンウォッシングなので、重点は「検証していないものを
// 検証済みに見せていないか」「分からないものを推測で埋めていないか」に置く。
const c = require('../../src/gpu/carbon-intensity');

afterEach(() => c.setIntensityProvider(null));

describe('lookupIntensity', () => {
  it('resolves a country code case-insensitively', () => {
    expect(c.lookupIntensity({ country: 'NO' }).gCO2PerKWh).toBe(30);
    expect(c.lookupIntensity({ country: 'no' }).gCO2PerKWh).toBe(30);
    expect(c.lookupIntensity({ country: ' no ' }).gCO2PerKWh).toBe(30);
  });

  it('prefers a sub-region, because within-country variance is huge', () => {
    // 米国は州で 90〜750 と 8 倍以上開く。国単位で丸めると水力と石炭が同点になる。
    const wa = c.lookupIntensity({ country: 'US', region: 'WA' });
    const wv = c.lookupIntensity({ country: 'US', region: 'WV' });
    expect(wa.gCO2PerKWh).toBeLessThan(wv.gCO2PerKWh / 5);
    expect(wa.granularity).toBe('region');
    expect(wa.matched).toBe('US-WA');
  });

  it('accepts the region either bare or already prefixed', () => {
    expect(c.lookupIntensity({ country: 'US', region: 'WA' }).matched).toBe('US-WA');
    expect(c.lookupIntensity({ country: 'US', region: 'US-WA' }).matched).toBe('US-WA');
  });

  it('falls back to the country when the sub-region is unknown', () => {
    const r = c.lookupIntensity({ country: 'US', region: 'ZZ' });
    expect(r.granularity).toBe('country');
    expect(r.gCO2PerKWh).toBe(c.COUNTRY_INTENSITY.US);
  });

  it('returns null rather than a world average for an unknown region', () => {
    // 世界平均で埋めると、実際には高炭素の地域が中庸に見えてしまう
    for (const loc of [{ country: 'ZZ' }, {}, { country: null }, { country: 42 }]) {
      const r = c.lookupIntensity(loc);
      expect(r.gCO2PerKWh).toBeNull();
      expect(r.confidence).toBe('unknown');
    }
  });

  it('never claims a verified green credential — location is self-declared', () => {
    // グリーンウォッシング防止の中核。粒度が細かくても「検証済み」にはならない。
    expect(c.lookupIntensity({ country: 'NO' }).confidence).toBe('self-declared-location');
    expect(c.lookupIntensity({ country: 'US', region: 'WA' }).confidence).toBe('self-declared-location');
  });
});

describe('live intensity provider', () => {
  it('overrides the static table and is marked as measured', () => {
    c.setIntensityProvider(() => 123);
    const r = c.lookupIntensity({ country: 'PL' });
    expect(r.gCO2PerKWh).toBe(123);
    expect(r.granularity).toBe('live');
    expect(r.confidence).toBe('measured-grid');
  });

  it('falls back to the static table when the provider returns nothing usable', () => {
    for (const bad of [null, undefined, NaN, -5, 'x']) {
      c.setIntensityProvider(() => bad);
      expect(c.lookupIntensity({ country: 'PL' }).gCO2PerKWh).toBe(c.COUNTRY_INTENSITY.PL);
    }
  });

  it('does not let a throwing provider break the estimate', () => {
    c.setIntensityProvider(() => { throw new Error('API down'); });
    expect(c.lookupIntensity({ country: 'NO' }).gCO2PerKWh).toBe(30);
  });

  it('ignores a non-function provider', () => {
    c.setIntensityProvider('not a function');
    expect(c.lookupIntensity({ country: 'NO' }).granularity).toBe('country');
  });
});

describe('intensityTier', () => {
  it('maps intensities onto tiers', () => {
    expect(c.intensityTier(30)).toBe('very_low');
    expect(c.intensityTier(200)).toBe('low');
    expect(c.intensityTier(370)).toBe('moderate');
    expect(c.intensityTier(600)).toBe('high');
    expect(c.intensityTier(700)).toBe('very_high');
  });

  it('returns null for missing or nonsensical input', () => {
    expect(c.intensityTier(null)).toBeNull();
    expect(c.intensityTier(-1)).toBeNull();
    expect(c.intensityTier('300')).toBeNull();
  });
});

describe('estimateEmissionsGrams', () => {
  it('accounts for datacentre overhead (PUE), not just the GPU draw', () => {
    // 450W を 1 時間、400 gCO2/kWh、PUE 1.2 → 0.45*1.2*400 = 216 g
    expect(c.estimateEmissionsGrams({ powerWatt: 450, hours: 1, gCO2PerKWh: 400, pue: 1.2 })).toBe(216);
    // PUE 1.0（オーバーヘッド無し）なら 180 g
    expect(c.estimateEmissionsGrams({ powerWatt: 450, hours: 1, gCO2PerKWh: 400, pue: 1 })).toBe(180);
  });

  it('scales linearly with duration', () => {
    const oneHour = c.estimateEmissionsGrams({ powerWatt: 100, hours: 1, gCO2PerKWh: 500 });
    const threeHours = c.estimateEmissionsGrams({ powerWatt: 100, hours: 3, gCO2PerKWh: 500 });
    expect(threeHours).toBeCloseTo(oneHour * 3, 5);
  });

  it('returns null on malformed input instead of a bogus number', () => {
    expect(c.estimateEmissionsGrams({ powerWatt: 'x', hours: 1, gCO2PerKWh: 400 })).toBeNull();
    expect(c.estimateEmissionsGrams({ powerWatt: 450, hours: 1, gCO2PerKWh: null })).toBeNull();
    expect(c.estimateEmissionsGrams({ powerWatt: 450, hours: 1, gCO2PerKWh: 400, pue: 0 })).toBeNull();
    expect(c.estimateEmissionsGrams()).toBeNull();
  });
});

describe('summarize', () => {
  it('produces the API/UI shape for a known location', () => {
    const s = c.summarize({ powerWatt: 450, location: { country: 'NO' } });
    expect(s).toMatchObject({
      gCO2PerKWh: 30, tier: 'very_low', matched: 'NO',
      granularity: 'country', confidence: 'self-declared-location', pue: c.DEFAULT_PUE,
    });
    expect(s.gramsPerHour).toBeCloseTo(16.2, 1);
  });

  it('withholds every number when the location is unknown', () => {
    const s = c.summarize({ powerWatt: 450, location: { country: 'ZZ' } });
    expect(s.gCO2PerKWh).toBeNull();
    expect(s.tier).toBeNull();
    expect(s.gramsPerHour).toBeNull();
    expect(s.confidence).toBe('unknown');
  });

  it('ranks a low-carbon region ahead of a high-carbon one for the same hardware', () => {
    const gpu = { powerWatt: 450 };
    const norway = c.summarize({ ...gpu, location: { country: 'NO' } });
    const poland = c.summarize({ ...gpu, location: { country: 'PL' } });
    expect(norway.gramsPerHour).toBeLessThan(poland.gramsPerHour / 10);
  });

  it('is safe on an empty listing', () => {
    expect(c.summarize().gCO2PerKWh).toBeNull();
    expect(c.summarize({}).gramsPerHour).toBeNull();
  });
});
