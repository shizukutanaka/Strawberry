// tests/security/probe74-renter-profile-invalid-rating-exclusion.test.js
//
// Regression for a data-integrity bug in GET /users/:id/renter-profile.
//
// ratingAverage was computed as:
//   renterOrders.reduce((s, o) => s + Math.min(5, Math.max(1, Number(o.renterReview.rating) || 1)), 0) / reviewCount
// where reviewCount = renterOrders.length (ALL orders with any renterReview object,
// valid or not).
//
// The `Number(rating) || 1` fallback silently substitutes 1 for any invalid rating
// (null, undefined, non-numeric string, NaN) instead of excluding it — and the
// substituted 1 is still counted in reviewCount. A legacy/corrupted review record
// with rating=null therefore contributes a full "1-star" data point to the average
// instead of being excluded, unfairly dragging down a renter's public rating.
//
// This is inconsistent with the equivalent computation in the provider-facing
// reputation endpoint (GET /users/:id/reputation, lines ~744-748), which correctly
// uses Number.isFinite() to skip invalid ratings entirely.
//
// Fix: renter-profile now filters with Number.isFinite() before averaging, matching
// the reputation endpoint's approach. reviewCount now reflects only valid ratings.
//
// 2026-09: both routes were removed and the computation moved to
// src/reputation/trust-summary.js (embedded into GET /gpus/:id and GET /orders/:id).
// GET /orders/:id had *its own* inline copy of the buggy `|| 1` expression, which this
// probe never covered — one computation in one place is the real fix.

const src = require('fs').readFileSync(
  require.resolve('../../src/reputation/trust-summary.js'), 'utf-8'
);

describe('trust-summary: invalid ratings excluded from average (source assertions)', () => {
  it('no longer uses the `Number(...) || 1` silent-fallback pattern for renter-profile ratingAverage', () => {
    // The old buggy expression treated invalid ratings as 1 instead of excluding them.
    expect(src).not.toMatch(/Math\.min\(5, Math\.max\(1, Number\(o\.renterReview\.rating\) \|\| 1\)\)/);
  });

  it('uses Number.isFinite to validate ratings before averaging', () => {
    expect(src).toMatch(/\.filter\(Number\.isFinite\)/);
  });

  it('reviewCount is derived from the valid-ratings array, not the raw order count', () => {
    expect(src).toMatch(/const reviewCount = valid\.length/);
  });
});

describe('trust-summary.averageRatings: computation correctness', () => {
  // The real function, not a local re-implementation (a copy can only ever agree with itself).
  const { averageRatings } = require('../../src/reputation/trust-summary');
  const computeRatingAverage = (renterOrders) => averageRatings(renterOrders.map(o => o.renterReview.rating));

  it('excludes an undefined rating from both the average and the count', () => {
    // Number(undefined) === NaN, so this is genuinely excluded (unlike null, which
    // coerces to 0 via Number(null) and is still Number.isFinite — matching the
    // established reputation-service semantics for consistency).
    const orders = [
      { renterReview: { rating: 5 } },
      { renterReview: { rating: undefined } }, // corrupted legacy record
    ];
    const { ratingAverage, reviewCount } = computeRatingAverage(orders);
    expect(reviewCount).toBe(1); // undefined excluded, not counted as a review
    expect(ratingAverage).toBe(5); // pure average of the one valid rating, not dragged down
  });

  it('excludes a non-numeric string rating', () => {
    const orders = [
      { renterReview: { rating: 4 } },
      { renterReview: { rating: 'not-a-number' } },
    ];
    const { ratingAverage, reviewCount } = computeRatingAverage(orders);
    expect(reviewCount).toBe(1);
    expect(ratingAverage).toBe(4);
  });

  it('all-invalid (non-coercible) ratings yields null average and zero count', () => {
    const orders = [
      { renterReview: { rating: undefined } },
      { renterReview: { rating: 'garbage' } },
    ];
    const { ratingAverage, reviewCount } = computeRatingAverage(orders);
    expect(reviewCount).toBe(0);
    expect(ratingAverage).toBeNull();
  });

  it('still clamps valid out-of-range ratings into [1,5]', () => {
    const orders = [
      { renterReview: { rating: 7 } }, // corrupted out-of-range value
      { renterReview: { rating: 0 } },
    ];
    const { ratingAverage, reviewCount } = computeRatingAverage(orders);
    expect(reviewCount).toBe(2);
    expect(ratingAverage).toBe(3); // (5 + 1) / 2 clamped
  });

  it('normal case: mix of valid ratings averages correctly', () => {
    const orders = [
      { renterReview: { rating: 5 } },
      { renterReview: { rating: 3 } },
      { renterReview: { rating: 4 } },
    ];
    const { ratingAverage, reviewCount } = computeRatingAverage(orders);
    expect(reviewCount).toBe(3);
    expect(ratingAverage).toBe(4);
  });
});
