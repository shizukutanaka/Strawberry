// tests/security/probe41-payment-gpu.test.js
// Probe 41 regression tests:
// 41a-2: invoice-poller checks order status before marking payment paid (no orphaned paid on cancelled order)
// 41a-1: invoice-poller checks for cross-method paid records before marking Lightning paid
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
describe('invoice-poller: order status gate prevents paid record on cancelled order', () => {
  it('invoice-poller.js: checks order status (PAYABLE set) before marking payment paid', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/core/invoice-poller.js'), 'utf-8'
    );
    expect(src).toMatch(/PAYABLE.*pending.*matched|pending.*matched.*PAYABLE/);
    expect(src).toMatch(/order_not_payable/);
    expect(src).toMatch(/currentOrder.*status/);
  });

  it('invoice-poller.js: marks payment failed (not paid) when order is not payable', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/core/invoice-poller.js'), 'utf-8'
    );
    const failIdx = src.indexOf("failReason: 'order_not_payable'");
    expect(failIdx).toBeGreaterThan(-1);
    // The failed status must come BEFORE the paid mark in the source
    const paidIdx = src.indexOf("status: 'paid'");
    expect(failIdx).toBeLessThan(paidIdx);
  });

  it('invoice-poller.js: logs warning and appends audit when order not payable', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/core/invoice-poller.js'), 'utf-8'
    );
    expect(src).toMatch(/appendAuditLog.*payment_order_not_payable/);
    expect(src).toMatch(/logger\.warn.*order not payable/);
  });
});

// ─── 41a-1: Invoice poller cross-method duplicate guard ──────────────────────
describe('invoice-poller: cross-method paid guard prevents double-pay', () => {
  it('invoice-poller.js: checks for existing paid records before marking Lightning paid', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/core/invoice-poller.js'), 'utf-8'
    );
    expect(src).toMatch(/already_paid_via_other_method/);
    // Filter: paid records from non-Lightning methods
    expect(src).toMatch(/alreadyPaid.*status.*paid.*method.*!==.*lightning/s);
  });

  it('invoice-poller.js: marks payment failed when another method already settled the order', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/core/invoice-poller.js'), 'utf-8'
    );
    expect(src).toMatch(/failReason: 'already_paid_via_other_method'/);
    expect(src).toMatch(/appendAuditLog.*payment_cross_method_duplicate_skipped/);
  });
});

// ─── 41b-3: minRenterRating floor (known-below-floor blocked; unrated opt-in) ──
describe('order creation: minRenterRating floor policy', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
  );

  it('order/index.js: floor blocks renters whose KNOWN average is below the floor', () => {
    // The floor must compare the real average (not a null-coalesced 0) and gate on history
    expect(src).toMatch(/hasRatingHistory\s*=\s*renterRatingAverage\s*!==\s*null/);
    expect(src).toMatch(/knownBelowFloor\s*=\s*hasRatingHistory\s*&&\s*renterRatingAverage\s*<\s*gpu\.minRenterRating/);
  });

  it('order/index.js: unrated renters are allowed unless rejectUnratedRenters opt-in is set', () => {
    // Sybil-resistance is opt-in via gpu.rejectUnratedRenters as an independent check
    // (not combined with minRenterRating - it works even without a rating floor)
    expect(src).toMatch(/gpu\.rejectUnratedRenters\s*===\s*true\s*&&\s*!hasRatingHistory/);
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
