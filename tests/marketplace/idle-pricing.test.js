// §4(3): 空転割引（perishable inventory 値下げ）の純関数テスト。
const { idleAdjustedPrice, lastBusyAtByGpu } = require('../../src/marketplace/idle-pricing');

const NOW = 1_700_000_000_000; // fixed epoch
const HOUR = 3.6e6;

const gpu = (idleDiscount) => ({ pricePerHour: 1000, createdAt: new Date(NOW - 100 * HOUR).toISOString(), idleDiscount });

describe('idleAdjustedPrice (§4)', () => {
  it('returns base price when idleDiscount is absent/disabled', () => {
    expect(idleAdjustedPrice(gpu(undefined), NOW - 50 * HOUR, NOW).pricePerHour).toBe(1000);
    expect(idleAdjustedPrice(gpu({ enabled: false }), NOW - 50 * HOUR, NOW).pricePerHour).toBe(1000);
  });

  it('applies linear decay past the threshold', () => {
    // 10h idle, threshold 1h, 5%/h → 45% discount → 550
    const r = idleAdjustedPrice(gpu({ enabled: true, pctPerHour: 5, thresholdHours: 1 }), NOW - 10 * HOUR, NOW);
    expect(r.discountPct).toBe(45);
    expect(r.pricePerHour).toBe(550);
    expect(r.basePricePerHour).toBe(1000);
  });

  it('caps discount at maxPct', () => {
    const r = idleAdjustedPrice(gpu({ enabled: true, pctPerHour: 5, maxPct: 30, thresholdHours: 0 }), NOW - 100 * HOUR, NOW);
    expect(r.discountPct).toBe(30);
    expect(r.pricePerHour).toBe(700);
  });

  it('no discount within threshold', () => {
    const r = idleAdjustedPrice(gpu({ enabled: true, pctPerHour: 5, thresholdHours: 24 }), NOW - 10 * HOUR, NOW);
    expect(r.discountPct).toBe(0);
    expect(r.pricePerHour).toBe(1000);
  });

  it('falls back to createdAt when the GPU has never been used', () => {
    const g = gpu({ enabled: true, pctPerHour: 10, thresholdHours: 0 });
    const r = idleAdjustedPrice(g, null, NOW);
    expect(r.idleHours).toBeCloseTo(100, 0);
    expect(r.discountPct).toBe(50); // capped at default maxPct
  });

  it('clamps out-of-range discount params', () => {
    const r = idleAdjustedPrice(gpu({ enabled: true, pctPerHour: 500, maxPct: 200, thresholdHours: -5 }), NOW - 10 * HOUR, NOW);
    expect(r.discountPct).toBeLessThanOrEqual(90);
  });
});

describe('lastBusyAtByGpu', () => {
  it('uses the latest scheduledEndAt per gpu', () => {
    const orders = [
      { gpuId: 'g1', scheduledEndAt: new Date(NOW - 10 * HOUR).toISOString() },
      { gpuId: 'g1', scheduledEndAt: new Date(NOW - 2 * HOUR).toISOString() },
      { gpuId: 'g2', scheduledEndAt: new Date(NOW - 5 * HOUR).toISOString() },
      { gpuId: 'g3' }, // no scheduledEndAt
    ];
    const m = lastBusyAtByGpu(orders);
    expect(m.get('g1')).toBe(NOW - 2 * HOUR);
    expect(m.get('g2')).toBe(NOW - 5 * HOUR);
    expect(m.get('g3')).toBeUndefined();
  });
});
