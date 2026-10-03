// tests/services/renter-eligibility.test.js
// Unit tests for the single source of truth that both POST /orders and
// GET /gpus/:id/eligibility use to decide whether a renter may book a GPU.

const { computeRenterRating, evaluateRenterEligibility } = require('../../src/services/renter-eligibility');

describe('computeRenterRating', () => {
  it('returns no-history for a renter with zero reviewed orders', () => {
    const r = computeRenterRating([], 'renter');
    expect(r).toEqual({ average: null, count: 0, hasHistory: false });
  });

  it('ignores orders belonging to other users', () => {
    const orders = [
      { userId: 'other', renterReview: { rating: 5 } },
      { userId: 'renter', renterReview: { rating: 4 } },
    ];
    const r = computeRenterRating(orders, 'renter');
    expect(r.count).toBe(1);
    expect(r.average).toBe(4);
  });

  it('ignores orders without a renterReview', () => {
    const orders = [
      { userId: 'renter' }, // no review
      { userId: 'renter', renterReview: { rating: 2 } },
    ];
    const r = computeRenterRating(orders, 'renter');
    expect(r.count).toBe(1);
    expect(r.average).toBe(2);
  });

  it('skips out-of-range ratings instead of clamping into [1,5]', () => {
    const orders = [
      { userId: 'renter', renterReview: { rating: 99 } },  // 破損 — 除外
      { userId: 'renter', renterReview: { rating: -3 } },  // 破損 — 除外
      { userId: 'renter', renterReview: { rating: 4 } },
    ];
    const r = computeRenterRating(orders, 'renter');
    // クランプ(5+1+4)/3=3.3 ではなく有効レコードのみ (4)/1
    expect(r.count).toBe(1);
    expect(r.average).toBe(4);
  });

  it('skips non-numeric ratings instead of treating them as 1', () => {
    const orders = [
      { userId: 'renter', renterReview: { rating: 'garbage' } }, // 破損 — 除外
      { userId: 'renter', renterReview: { rating: null } },      // Number→0 — 除外
      { userId: 'renter', renterReview: { rating: true } },      // Number→1 — 除外
      { userId: 'renter', renterReview: { rating: 5 } },
    ];
    const r = computeRenterRating(orders, 'renter');
    // 破損値が 1 点として平均を押し下げない — 有効分のみ
    expect(r.count).toBe(1);
    expect(r.average).toBe(5);
  });

  it('reports no history when every stored rating is corrupt', () => {
    const orders = [
      { userId: 'renter', renterReview: { rating: 'x' } },
      { userId: 'renter', renterReview: { rating: 0 } },
    ];
    const r = computeRenterRating(orders, 'renter');
    expect(r).toEqual({ average: null, count: 0, hasHistory: false });
  });

  it('rounds the average to one decimal place', () => {
    const orders = [
      { userId: 'renter', renterReview: { rating: 5 } },
      { userId: 'renter', renterReview: { rating: 5 } },
      { userId: 'renter', renterReview: { rating: 4 } },
    ];
    const r = computeRenterRating(orders, 'renter'); // 14/3 = 4.666...
    expect(r.average).toBe(4.7);
  });
});

describe('evaluateRenterEligibility', () => {
  const baseGpu = { id: 'g1', providerId: 'prov', available: true };
  const noHistory = { average: null, count: 0, hasHistory: false };
  const goodHistory = { average: 4.5, count: 3, hasHistory: true };
  const badHistory = { average: 2.0, count: 3, hasHistory: true };

  it('returns not_found when gpu is null', () => {
    const r = evaluateRenterEligibility(null, 'renter', noHistory);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('not_found');
  });

  it('blocks self-trade (renter is the provider)', () => {
    const r = evaluateRenterEligibility(baseGpu, 'prov', goodHistory);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('self_trade');
  });

  it('allows an unrestricted available GPU for a rated renter', () => {
    const r = evaluateRenterEligibility(baseGpu, 'renter', goodHistory);
    expect(r.eligible).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('allows an unrated renter when rejectUnratedRenters is not set', () => {
    const gpu = { ...baseGpu, minRenterRating: 4.0 };
    const r = evaluateRenterEligibility(gpu, 'renter', noHistory);
    expect(r.eligible).toBe(true);
  });

  it('blocks an unrated renter when rejectUnratedRenters is true (no floor needed)', () => {
    const gpu = { ...baseGpu, rejectUnratedRenters: true };
    const r = evaluateRenterEligibility(gpu, 'renter', noHistory);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('no_rating_history');
  });

  it('blocks a renter below the rating floor', () => {
    const gpu = { ...baseGpu, minRenterRating: 4.0 };
    const r = evaluateRenterEligibility(gpu, 'renter', badHistory);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('below_rating_floor');
    expect(r.message).toMatch(/2/);
  });

  it('allows a renter who meets the rating floor exactly', () => {
    const gpu = { ...baseGpu, minRenterRating: 4.0 };
    const r = evaluateRenterEligibility(gpu, 'renter', { average: 4.0, count: 2, hasHistory: true });
    expect(r.eligible).toBe(true);
  });

  it('blocks when GPU is unavailable (checked after rating gates)', () => {
    const gpu = { ...baseGpu, available: false };
    const r = evaluateRenterEligibility(gpu, 'renter', goodHistory);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('not_available');
  });

  it('prioritizes self_trade over availability', () => {
    const gpu = { ...baseGpu, available: false };
    const r = evaluateRenterEligibility(gpu, 'prov', goodHistory);
    expect(r.reason).toBe('self_trade');
  });

  it('prioritizes rating gates over availability', () => {
    // An unavailable GPU that also rejects unrated renters reports the rating reason first,
    // matching POST /orders order-of-checks (rating gate throws 422 before availability 409).
    const gpu = { ...baseGpu, available: false, rejectUnratedRenters: true };
    const r = evaluateRenterEligibility(gpu, 'renter', noHistory);
    expect(r.reason).toBe('no_rating_history');
  });
});
