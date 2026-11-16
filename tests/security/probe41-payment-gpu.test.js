// tests/security/probe41-payment-gpu.test.js
// Probe 41 regression tests:
// 41b-3: minRenterRating floor blocks renters with a KNOWN average below the floor.
//        Unrated newcomers are allowed by default (marketplace onboarding); providers
//        can opt into Sybil-resistant strictness with gpu.rejectUnratedRenters:true.
// 41b-2: certChain schema accepts array (matches verifier expectation)

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 41a-2: Invoice poller checks order status before marking paid ────────────
describe('order creation: minRenterRating floor policy', () => {
  const { computeRenterRating, evaluateRenterEligibility } = require('../../src/services/renter-eligibility');

  function ratingFor(average, count) {
    if (count === 0) return { average: null, count: 0, hasHistory: false };
    return { average, count, hasHistory: true };
  }

  it('floor blocks renters whose KNOWN average is below the floor', () => {
    const gpu = { id: 'g1', providerId: 'prov', minRenterRating: 4.0, available: true };
    const res = evaluateRenterEligibility(gpu, 'renter', ratingFor(2.5, 3));
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe('below_rating_floor');
  });

  it('floor allows renters whose KNOWN average meets the floor', () => {
    const gpu = { id: 'g1', providerId: 'prov', minRenterRating: 4.0, available: true };
    const res = evaluateRenterEligibility(gpu, 'renter', ratingFor(4.5, 3));
    expect(res.eligible).toBe(true);
  });

  it('unrated renters are allowed unless rejectUnratedRenters opt-in is set', () => {
    // Without opt-in, an unrated renter is eligible even with a floor set.
    const gpuNoOptIn = { id: 'g1', providerId: 'prov', minRenterRating: 4.0, available: true };
    expect(evaluateRenterEligibility(gpuNoOptIn, 'renter', ratingFor(null, 0)).eligible).toBe(true);

    // With opt-in, an unrated renter is blocked — independent of minRenterRating presence.
    const gpuOptIn = { id: 'g1', providerId: 'prov', rejectUnratedRenters: true, available: true };
    const res = evaluateRenterEligibility(gpuOptIn, 'renter', ratingFor(null, 0));
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe('no_rating_history');
  });

  it('computeRenterRating clamps ratings to 1-5 and averages correctly', () => {
    const orders = [
      { userId: 'r', renterReview: { rating: 5 } },
      { userId: 'r', renterReview: { rating: 1 } },
      { userId: 'other', renterReview: { rating: 3 } }, // different user, ignored
    ];
    const r = computeRenterRating(orders, 'r');
    expect(r.count).toBe(2);
    expect(r.average).toBe(3.0);
    expect(r.hasHistory).toBe(true);
  });

  it('order/index.js delegates the eligibility check to the shared module', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // Must use the single source of truth, not a re-implemented inline check.
    expect(src).toMatch(/evaluateRenterEligibility/);
    // The old forced-0 bypass-prevention form must be gone
    expect(src).not.toMatch(/renterRatingAverage \?\? 0/);
    expect(src).not.toMatch(/null bypass prevention/);
  });
});

// ─── 41b-2: certChain schema accepts array ────────────────────────────────────
describe('certChain schema: array accepted to match attestation verifier expectation', () => {
  it('validator.js: certChain schema outer type is Joi.array (not Joi.string)', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/validator.js'), 'utf-8'
    );
    // certChain must start with Joi.array() as outer type
    expect(src).toMatch(/certChain:\s*Joi\.array\(\)/);
    // The old form: certChain: Joi.string() must be gone
    expect(src).not.toMatch(/certChain:\s*Joi\.string\(\)/);
  });

  it('validator.js: certChain array has item and count limits', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/validator.js'), 'utf-8'
    );
    // Must have max item count (DoS prevention)
    const certChainIdx = src.indexOf('certChain: Joi.array()');
    expect(certChainIdx).toBeGreaterThan(-1);
    const certBlock = src.slice(certChainIdx, certChainIdx + 80);
    expect(certBlock).toMatch(/max\(10\)/);
  });
});
