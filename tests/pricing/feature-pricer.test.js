// tests/pricing/feature-pricer.test.js
const { computePrice, generationScore } = require('../../src/pricing/feature-pricer');

const REF = { vramGB: 24, memBandwidthGBs: 900, benchmarkScore: 100, generationScore: 1.0 };

describe('feature-pricer: computePrice', () => {
  it('a reference GPU at balanced demand prices ~= baseRate', () => {
    const r = computePrice(REF, { utilization: 0.5 }, { baseRatePerHour: 1000 });
    expect(r.pricePerHour).toBeCloseTo(1000, 5);
    expect(r.pricePer5Min).toBeCloseTo(1000 / 12, 5);
  });

  it('a beefier GPU (more VRAM/bandwidth/benchmark) costs more', () => {
    const big = computePrice(
      { vramGB: 80, memBandwidthGBs: 3350, benchmarkScore: 300, generation: 'hopper' },
      { utilization: 0.5 },
      { baseRatePerHour: 1000 }
    );
    expect(big.pricePerHour).toBeGreaterThan(1000);
    expect(big.breakdown.featureMultiplier).toBeGreaterThan(1);
  });

  it('surges under high demand and discounts under low demand', () => {
    const hi = computePrice(REF, { utilization: 0.95 }, { baseRatePerHour: 1000 });
    const lo = computePrice(REF, { utilization: 0.05 }, { baseRatePerHour: 1000 });
    expect(hi.pricePerHour).toBeGreaterThan(1000);
    expect(lo.pricePerHour).toBeLessThan(1000);
    expect(hi.breakdown.demandMultiplier).toBeGreaterThan(lo.breakdown.demandMultiplier);
  });

  it('applies a perishability discount for idle spot inventory', () => {
    const normal = computePrice(REF, { utilization: 0.5 }, { baseRatePerHour: 1000 });
    const idle = computePrice(REF, { utilization: 0.5, spotIdle: true }, { baseRatePerHour: 1000, spotIdleDiscount: 0.6 });
    expect(idle.pricePerHour).toBeCloseTo(normal.pricePerHour * 0.6, 5);
  });

  it('clamps to floor and cap', () => {
    // weak GPU prices low; a floor above that computed price binds
    const floored = computePrice({}, { utilization: 0.5 }, { baseRatePerHour: 1000, floorPerHour: 300 });
    expect(floored.pricePerHour).toBe(300);
    const capped = computePrice(
      { vramGB: 1e6, benchmarkScore: 1e6, memBandwidthGBs: 1e6 },
      { utilization: 1 },
      { baseRatePerHour: 1000, capPerHour: 5000 }
    );
    expect(capped.pricePerHour).toBe(5000);
  });

  it('honors GPU generation ranking', () => {
    expect(generationScore({ generation: 'hopper' })).toBeGreaterThan(generationScore({ generation: 'ampere' }));
    expect(generationScore({ generation: 'unknown-xyz' })).toBe(1.0);
    expect(generationScore({ generationScore: 3.1 })).toBe(3.1);
  });

  it('demand multiplier respects min/max bounds', () => {
    const r = computePrice(REF, { utilization: 1 }, { baseRatePerHour: 1000, surgeSensitivity: 100, maxDemandMultiplier: 2.5 });
    expect(r.breakdown.demandMultiplier).toBeLessThanOrEqual(2.5);
  });
});
