// tests/payments/settlement-calculator.test.js
const { computeSettlement, DEFAULTS } = require('../../src/payments/settlement-calculator');

// 各内訳が総額を完全に分配しているか（保存則）を共通チェック
function expectConserved(r, total) {
  expect(r.providerPayoutSats + r.operatorFeeSats + r.renterRefundSats).toBe(total);
  expect(r.providerPayoutSats + r.operatorFeeSats).toBe(r.chargedSats);
  expect(r.providerPayoutSats).toBeGreaterThanOrEqual(0);
  expect(r.operatorFeeSats).toBeGreaterThanOrEqual(0);
  expect(r.renterRefundSats).toBeGreaterThanOrEqual(0);
}

describe('settlement-calculator', () => {
  it('full delivery + 100% SLA charges the whole amount (minus fee)', () => {
    const r = computeSettlement({ totalSats: 10000, deliveredRatio: 1, slaUptimePct: 100, feeRate: 0.015 });
    expect(r.chargedSats).toBe(10000);
    expect(r.renterRefundSats).toBe(0);
    expect(r.operatorFeeSats).toBe(150);
    expect(r.providerPayoutSats).toBe(9850);
    expectConserved(r, 10000);
  });

  it('half delivery charges roughly half and refunds the rest', () => {
    const r = computeSettlement({ totalSats: 10000, deliveredRatio: 0.5, slaUptimePct: 100, feeRate: 0 });
    expect(r.chargedSats).toBe(5000);
    expect(r.renterRefundSats).toBe(5000);
    expectConserved(r, 10000);
  });

  it('applies the minimum charge floor for near-zero delivery', () => {
    const r = computeSettlement({ totalSats: 10000, deliveredRatio: 0.01, slaUptimePct: 100, feeRate: 0 });
    // floor is 10% → charged 1000, not 100
    expect(r.chargedSats).toBe(1000);
    expect(r.renterRefundSats).toBe(9000);
    expectConserved(r, 10000);
  });

  it('zero delivery still charges the minimum (setup) fee', () => {
    const r = computeSettlement({ totalSats: 10000, deliveredRatio: 0, slaUptimePct: 100, feeRate: 0 });
    expect(r.chargedSats).toBe(1000);
    expectConserved(r, 10000);
  });

  it('SLA below threshold reduces the charge in favor of the renter', () => {
    const good = computeSettlement({ totalSats: 10000, deliveredRatio: 1, slaUptimePct: 100, feeRate: 0 });
    const bad = computeSettlement({ totalSats: 10000, deliveredRatio: 1, slaUptimePct: 50, feeRate: 0 });
    expect(bad.chargedSats).toBeLessThan(good.chargedSats);
    expect(bad.renterRefundSats).toBeGreaterThan(0);
    expect(bad.breakdown.slaPenalty).toBeGreaterThan(0);
    expectConserved(bad, 10000);
  });

  it('SLA at/above threshold incurs no penalty', () => {
    const r = computeSettlement({ totalSats: 10000, deliveredRatio: 1, slaUptimePct: DEFAULTS.slaThresholdPct, feeRate: 0 });
    expect(r.breakdown.slaPenalty).toBe(0);
    expect(r.chargedSats).toBe(10000);
  });

  it('worst SLA (0%) applies the full configured penalty cap', () => {
    const r = computeSettlement({ totalSats: 10000, deliveredRatio: 1, slaUptimePct: 0, feeRate: 0 });
    // effectiveRatio = 1 * (1 - 0.5) = 0.5
    expect(r.chargedSats).toBe(5000);
    expect(r.breakdown.slaPenalty).toBeCloseTo(DEFAULTS.slaPenaltyMax, 5);
  });

  it('fee rounding keeps conservation (odd amounts)', () => {
    const r = computeSettlement({ totalSats: 9999, deliveredRatio: 1, slaUptimePct: 100, feeRate: 0.025 });
    expectConserved(r, 9999);
  });

  it('zero total returns all-zero with no NaN', () => {
    const r = computeSettlement({ totalSats: 0, deliveredRatio: 1, slaUptimePct: 100, feeRate: 0.02 });
    expect(r).toMatchObject({ providerPayoutSats: 0, renterRefundSats: 0, operatorFeeSats: 0, chargedSats: 0 });
  });

  it('clamps out-of-range inputs (ratio>1, sla>100, negative)', () => {
    const r = computeSettlement({ totalSats: 10000, deliveredRatio: 5, slaUptimePct: 999, feeRate: -1 });
    expect(r.chargedSats).toBe(10000);
    expect(r.operatorFeeSats).toBe(0);
    expectConserved(r, 10000);
  });

  it('respects custom minChargeRatio / slaPenaltyMax opts', () => {
    const r = computeSettlement(
      { totalSats: 10000, deliveredRatio: 0, slaUptimePct: 100, feeRate: 0 },
      { minChargeRatio: 0.25 },
    );
    expect(r.chargedSats).toBe(2500);
  });

  it('is deterministic (pure function)', () => {
    const input = { totalSats: 12345, deliveredRatio: 0.42, slaUptimePct: 88, feeRate: 0.017 };
    expect(computeSettlement(input)).toEqual(computeSettlement(input));
  });
});
