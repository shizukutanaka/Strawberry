// tests/marketplace/spot-tier.test.js
// Spot（中断許容）ティアのポリシー。
// 重点は「割引の代償が正しく釣り合っているか」— 中断されたら提供時間分しか払わない、
// 猶予はプロバイダに削られない、中断は SLA 違反にしないが必ず開示する、の3点。
const spot = require('../../src/marketplace/spot-tier');

const spotGpu = (over = {}) => ({ pricePerHour: 1000, spotEnabled: true, ...over });

describe('normalizeTier', () => {
  it('defaults to ondemand for anything that is not exactly "spot"', () => {
    expect(spot.normalizeTier('spot')).toBe('spot');
    expect(spot.normalizeTier('ondemand')).toBe('ondemand');
    expect(spot.normalizeTier(undefined)).toBe('ondemand');
    expect(spot.normalizeTier('SPOT')).toBe('ondemand');
    expect(spot.normalizeTier({ toString: () => 'spot' })).toBe('ondemand');
  });
});

describe('resolveSpotConfig', () => {
  it('is opt-in — a listing without spotEnabled offers no spot tier', () => {
    expect(spot.resolveSpotConfig({}).enabled).toBe(false);
    expect(spot.resolveSpotConfig({ spotEnabled: 'yes' }).enabled).toBe(false);
  });

  it('clamps the discount into a range that keeps the trade honest', () => {
    // 0% 割引の「spot」は借り手に中断リスクだけ負わせる出品になる
    expect(spot.resolveSpotConfig(spotGpu({ spotDiscountPct: 0 })).discountPct)
      .toBe(spot.SPOT_DEFAULTS.minDiscountPct);
    expect(spot.resolveSpotConfig(spotGpu({ spotDiscountPct: 99 })).discountPct)
      .toBe(spot.SPOT_DEFAULTS.maxDiscountPct);
    expect(spot.resolveSpotConfig(spotGpu({ spotDiscountPct: 55 })).discountPct).toBe(55);
  });

  it('clamps the notice window — a zero-notice preemption makes the tier unusable', () => {
    // Bamboo (arXiv:2204.12013): 猶予ゼロだと借り手は計算を丸ごと捨てることになる
    expect(spot.resolveSpotConfig(spotGpu({ spotNoticeSeconds: 0 })).noticeSeconds)
      .toBe(spot.SPOT_DEFAULTS.minNoticeSeconds);
    expect(spot.resolveSpotConfig(spotGpu({ spotNoticeSeconds: 99999 })).noticeSeconds)
      .toBe(spot.SPOT_DEFAULTS.maxNoticeSeconds);
  });
});

describe('effectivePrice', () => {
  it('leaves on-demand pricing untouched', () => {
    const p = spot.effectivePrice(1000, 'ondemand', spotGpu());
    expect(p).toEqual({ pricePerHour: 1000, tier: 'ondemand', discountPct: 0, listPricePerHour: 1000 });
  });

  it('applies the listing discount for spot', () => {
    const p = spot.effectivePrice(1000, 'spot', spotGpu({ spotDiscountPct: 40 }));
    expect(p.pricePerHour).toBe(600);
    expect(p.discountPct).toBe(40);
    expect(p.listPricePerHour).toBe(1000);
  });

  it('refuses to price spot on a listing that does not offer it', () => {
    // 黙って定価にすると、借り手は中断リスクだけ負って割引を得られない
    expect(() => spot.effectivePrice(1000, 'spot', { pricePerHour: 1000 }))
      .toThrow(/does not offer the spot tier/);
  });

  it('never rounds a paid rental down to a free one', () => {
    // 1 sat が最小不可分単位。0 になると無料かつ支払い不能になる
    expect(spot.effectivePrice(1, 'spot', spotGpu({ spotDiscountPct: 90 })).pricePerHour).toBe(1);
  });

  it('rejects a non-positive list price', () => {
    expect(() => spot.effectivePrice(0, 'spot', spotGpu())).toThrow(/positive/);
    expect(() => spot.effectivePrice(null, 'ondemand', spotGpu())).toThrow(/positive/);
  });
});

describe('buildPreemptionNotice', () => {
  it('puts the deadline exactly one notice-window ahead', () => {
    const t0 = Date.parse('2026-08-01T00:00:00.000Z');
    const n = spot.buildPreemptionNotice(spotGpu({ spotNoticeSeconds: 120 }), t0);
    expect(n.noticeAt).toBe('2026-08-01T00:00:00.000Z');
    expect(n.deadlineAt).toBe('2026-08-01T00:02:00.000Z');
    expect(n.noticeSeconds).toBe(120);
  });
});

describe('preemptionSettlement', () => {
  const order = { startedAt: '2026-08-01T00:00:00.000Z', durationMinutes: 60 };

  it('charges strictly for delivered time', () => {
    const halfway = Date.parse('2026-08-01T00:30:00.000Z');
    const s = spot.preemptionSettlement(order, halfway);
    expect(s.deliveredSeconds).toBe(1800);
    expect(s.usage.deliveredRatio).toBeCloseTo(0.5, 6);
  });

  it('disables the minimum charge floor — this is what blocks zero-work billing', () => {
    // floor が残ると「受注→即中断→最低課金だけ回収」を繰り返せてしまう
    const s = spot.preemptionSettlement(order, Date.parse('2026-08-01T00:00:00.000Z'));
    expect(s.opts.minChargeRatio).toBe(0);
    expect(s.usage.deliveredRatio).toBe(0);
  });

  it('does not treat a preemption as an SLA breach', () => {
    // 仕様どおりに中断したプロバイダを SLA ペナルティで罰してはならない
    expect(spot.preemptionSettlement(order, Date.now()).usage.slaUptimePct).toBe(100);
  });

  it('never exceeds the full reservation even if the clock overruns', () => {
    const s = spot.preemptionSettlement(order, Date.parse('2026-08-01T09:00:00.000Z'));
    expect(s.usage.deliveredRatio).toBe(1);
  });

  it('is safe when the order never started or has no duration', () => {
    expect(spot.preemptionSettlement({ durationMinutes: 60 }, Date.now()).usage.deliveredRatio).toBe(0);
    expect(spot.preemptionSettlement({ startedAt: order.startedAt }, Date.now()).usage.deliveredRatio).toBe(0);
    expect(spot.preemptionSettlement().usage.deliveredRatio).toBe(0);
  });
});

describe('preemptionRate', () => {
  const finished = (tier, terminationReason) => ({ tier, status: 'completed', terminationReason });

  it('withholds a rate until there is enough evidence', () => {
    const r = spot.preemptionRate([finished('spot', 'preempted'), finished('spot')]);
    expect(r.rate).toBeNull();
    expect(r.measuring).toBe(true);
    expect(r.preempted).toBe(1);
  });

  it('computes the rate over finished spot orders only', () => {
    const orders = [
      finished('spot', 'preempted'), finished('spot', 'preempted'),
      finished('spot'), finished('spot'), finished('spot'),
      // 専有注文と進行中の注文は分母に入れない
      finished('ondemand', 'preempted'),
      { tier: 'spot', status: 'active' },
    ];
    const r = spot.preemptionRate(orders);
    expect(r.spotOrders).toBe(5);
    expect(r.preempted).toBe(2);
    expect(r.rate).toBe(0.4);
    expect(r.measuring).toBe(false);
  });

  it('reports no history rather than a fake zero', () => {
    const r = spot.preemptionRate([]);
    expect(r.rate).toBeNull();
    expect(r.measuring).toBe(false);
    expect(r.spotOrders).toBe(0);
  });
});
