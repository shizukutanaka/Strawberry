// tests/marketplace/spot-tier.test.js — §9 spot/中断可能ティアの純関数テスト
const {
  spotPricePerHour, buildPreemption, chargeableMinutesForPreemption,
  spotSettlement, findSpotAlternatives,
  DEFAULT_SPOT_NOTICE_SEC, MIN_NOTICE_SEC, MAX_NOTICE_SEC, DEFAULT_SPOT_DISCOUNT_PCT,
} = require('../../src/marketplace/spot-tier');

describe('spotPricePerHour', () => {
  it('is disabled unless spotEnabled===true', () => {
    expect(spotPricePerHour({ pricePerHour: 100 }).enabled).toBe(false);
    expect(spotPricePerHour({ pricePerHour: 100, spotEnabled: false }).enabled).toBe(false);
    expect(spotPricePerHour(null).enabled).toBe(false);
  });

  it('resolves explicit spotPricePerHour, capped at base price', () => {
    expect(spotPricePerHour({ spotEnabled: true, pricePerHour: 100, spotPricePerHour: 60 }).pricePerHour).toBe(60);
    // spot が通常価格以上なら割引の意味を成さない → base でキャップ
    expect(spotPricePerHour({ spotEnabled: true, pricePerHour: 100, spotPricePerHour: 150 }).pricePerHour).toBe(100);
  });

  it('applies spotDiscountPct, else the default discount', () => {
    expect(spotPricePerHour({ spotEnabled: true, pricePerHour: 100, spotDiscountPct: 50 }).pricePerHour).toBe(50);
    expect(spotPricePerHour({ spotEnabled: true, pricePerHour: 100 }).pricePerHour)
      .toBeCloseTo(100 * (1 - DEFAULT_SPOT_DISCOUNT_PCT / 100));
    // 割引率は [1,95] にクランプ
    expect(spotPricePerHour({ spotEnabled: true, pricePerHour: 100, spotDiscountPct: 200 }).pricePerHour)
      .toBeCloseTo(5);
  });
});

describe('buildPreemption', () => {
  it('defaults to 60s notice and computes deadlineAt', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const p = buildPreemption({ now });
    expect(p.noticeSec).toBe(DEFAULT_SPOT_NOTICE_SEC);
    expect(p.deadlineAt).toBe(new Date(now.getTime() + 60000).toISOString());
    expect(p.reason).toBeNull();
  });

  it('clamps noticeSec into [30, 600]', () => {
    const now = new Date();
    expect(buildPreemption({ noticeSec: 5, now }).noticeSec).toBe(MIN_NOTICE_SEC);
    expect(buildPreemption({ noticeSec: 99999, now }).noticeSec).toBe(MAX_NOTICE_SEC);
    expect(buildPreemption({ noticeSec: 90, reason: 'maintenance', now }).reason).toBe('maintenance');
  });
});

describe('chargeableMinutesForPreemption / spotSettlement', () => {
  const order = {
    startedAt: '2026-01-01T00:00:00Z',
    durationMinutes: 60,
    pricePerHour: 70, // spot価格（作成時にロック済み）
  };

  it('rounds elapsed up to 5-minute granularity', () => {
    // 12分経過 → 15分課金
    expect(chargeableMinutesForPreemption(order, new Date('2026-01-01T00:12:00Z'))).toBe(15);
    // 0 分経過 → 0
    expect(chargeableMinutesForPreemption(order, new Date('2026-01-01T00:00:00Z'))).toBe(0);
    // 予定時間超過はキャップされる
    expect(chargeableMinutesForPreemption(order, new Date('2026-01-01T02:00:00Z'))).toBe(60);
  });

  it('computes settlement at the locked spot price', () => {
    const s = spotSettlement(order, new Date('2026-01-01T00:12:00Z'));
    // 15min × (70/60) = 17.5 → round → 18 (整数 sat, 最低1)
    expect(s.chargeableMinutes).toBe(15);
    expect(s.totalPrice).toBe(Math.max(1, Math.round(70 / 60 * 15)));
    expect(s.pricePerHour).toBe(70);
  });

  it('falls back to scheduledStartAt when not yet started', () => {
    const pending = { scheduledStartAt: '2026-01-01T00:00:00Z', durationMinutes: 30, pricePerHour: 60 };
    const s = spotSettlement(pending, new Date('2026-01-01T00:06:00Z'));
    expect(s.chargeableMinutes).toBe(10);
  });
});

describe('findSpotAlternatives', () => {
  const mkGpu = (id, model, price, extra = {}) => ({
    id, model, pricePerHour: price, spotEnabled: true, spotPricePerHour: price, ...extra,
  });
  const order = { gpuId: 'a', scheduledStartAt: '2026-06-01T00:00:00Z', durationMinutes: 60 };
  const orig = mkGpu('a', 'RTX4090', 70);

  it('prefers same-model spot GPUs ordered by price, excludes busy/disabled', () => {
    const gpus = [
      orig,
      mkGpu('b', 'RTX4090', 80),           // same model, more expensive
      mkGpu('c', 'RTX4090', 60),           // same model, cheaper → first
      mkGpu('d', 'A100', 50),              // different model
      mkGpu('e', 'RTX4090', 40, { spotEnabled: false }), // spot off → excluded
      mkGpu('f', 'RTX4090', 30, { available: false }),   // unavailable → excluded
      mkGpu('g', 'RTX4090', 20),           // busy → excluded
    ];
    const orders = [
      { gpuId: 'g', status: 'active', scheduledStartAt: '2026-06-01T00:30:00Z', durationMinutes: 60 },
      { gpuId: 'b', status: 'completed', scheduledStartAt: '2026-06-01T00:00:00Z', durationMinutes: 60 }, // 完了済は blocking しない
    ];
    const alts = findSpotAlternatives(order, orig, { gpus, orders });
    expect(alts.map((a) => a.gpuId)).toEqual(['c', 'b', 'd']);
    expect(alts[0].spotPricePerHour).toBe(60);
  });

  it('returns empty when no spot GPU is free', () => {
    const alts = findSpotAlternatives(order, orig, { gpus: [orig], orders: [] });
    expect(alts).toEqual([]);
  });
});
