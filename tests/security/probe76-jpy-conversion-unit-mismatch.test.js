// tests/security/probe76-jpy-conversion-unit-mismatch.test.js
//
// Regression for a severe unit-mismatch bug in the sats→JPY display conversion.
//
// getBTCtoJPYRate() (src/utils/exchange-rate.js) returns a rate denominated as
// "JPY per 1 BTC" (e.g. 10,000,000 for the outage-fallback DEFAULT_RATE — see the
// module's own comment: "単位はライブ取得値と同じ「1 BTC あたりの JPY」"). But
// order.totalPrice is denominated in satoshis (1 BTC = 1e8 satoshis).
//
// Two call sites multiplied totalPrice (sats) directly by this BTC-denominated
// rate without first converting sats→BTC, inflating every displayed JPY figure
// by exactly 1e8x:
//
//   1. src/utils/order-pricing.js computeOrderPricing() — used for order list/
//      detail display.
//   2. src/api/routes/order/index.js order-creation handler — computes and
//      PERSISTS totalPriceJPY at order creation (the authoritative on-disk
//      value used later for admin GMV stats and earnings summaries).
//
// Concretely: a 1-satoshi order with a 10,000,000 JPY/BTC rate displayed as
// "10,000,000円" instead of the correct ~0.1円. The actual Lightning invoice
// amount (which uses totalPrice directly, never totalPriceJPY) was NOT
// affected — this was a display/reporting bug, not a fund-loss bug — but it
// misrepresented order value by eight orders of magnitude everywhere it was
// shown (order list, order detail, admin GMV dashboard, notification messages).
//
// Fix: divide totalPrice by 1e8 (sats→BTC) before multiplying by the BTC/JPY
// rate, in both call sites.

const { computeOrderPricing } = require('../../src/utils/order-pricing');

describe('computeOrderPricing: sats→JPY conversion uses correct unit scale', () => {
  it('1 satoshi at a realistic BTC/JPY rate does not round up to millions of yen', () => {
    const order = { totalPrice: 1, durationMinutes: 60, pricePerHour: 1 };
    const pricing = computeOrderPricing(order, { rate: 15000000, timestamp: Date.now() });
    // 1 sat / 1e8 * 15,000,000 = 0.15 JPY, rounds to 0. The old (buggy) code
    // would have produced 1 * 15,000,000 = 15,000,000.
    expect(pricing.totalPriceJPY).toBe(0);
  });

  it('a realistic order (200,000 sats) converts to the mathematically correct JPY amount', () => {
    // 200,000 sats = 0.002 BTC. At 15,000,000 JPY/BTC: 0.002 * 15,000,000 = 30,000 JPY.
    const order = { totalPrice: 200000, durationMinutes: 120, pricePerHour: 100000 };
    const pricing = computeOrderPricing(order, { rate: 15000000, timestamp: Date.now() });
    expect(pricing.totalPriceJPY).toBe(30000);
  });

  it('totalPriceJPY never exceeds totalPrice at any rate within the validated exchange-rate range [100000, 15000000]', () => {
    // Sanity invariant: since 1 BTC = 1e8 sats, and the rate cap is 15,000,000
    // JPY/BTC, a single satoshi is worth at most 15,000,000 / 1e8 = 0.15 JPY.
    // So totalPriceJPY should always be << totalPrice for any realistic amount,
    // never orders-of-magnitude larger. This is the invariant the bug violated.
    const order = { totalPrice: 1000, durationMinutes: 60, pricePerHour: 1000 };
    const pricing = computeOrderPricing(order, { rate: 15000000, timestamp: Date.now() });
    // Correct: 1000 sats / 1e8 * 15,000,000 = 150 JPY (way less than the buggy
    // 1000 * 15,000,000 = 15,000,000,000).
    expect(pricing.totalPriceJPY).toBe(150);
    expect(pricing.totalPriceJPY).toBeLessThan(order.totalPrice * 1000);
  });

  it('scales linearly with totalPrice at a fixed rate (no accidental extra scaling factor)', () => {
    const rateInfo = { rate: 10000000, timestamp: Date.now() };
    const small = computeOrderPricing({ totalPrice: 100, durationMinutes: 60, pricePerHour: 100 }, rateInfo);
    const large = computeOrderPricing({ totalPrice: 100000, durationMinutes: 60, pricePerHour: 100000 }, rateInfo);
    // 1000x more sats should yield ~1000x more JPY (within rounding).
    expect(large.totalPriceJPY).toBe(small.totalPriceJPY * 1000);
  });
});

describe('order-pricing.js source: divides by 1e8 before multiplying by the BTC/JPY rate', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../src/utils/order-pricing.js'), 'utf-8'
  );

  it('rawJPY computation includes a sats→BTC conversion (/ 1e8)', () => {
    expect(src).toMatch(/totalPrice \/ 1e8/);
  });

  it('no longer multiplies totalPrice directly by rateInfo.rate without the /1e8 conversion', () => {
    expect(src).not.toMatch(/Math\.round\(totalPrice \* rateInfo\.rate\)/);
  });
});

describe('order/index.js source: order-creation totalPriceJPY also divides by 1e8', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
  );

  it('order-creation rawJPY computation includes a sats→BTC conversion (/ 1e8)', () => {
    const idx = src.indexOf('const rawJPY = Math.round((totalPrice / 1e8)');
    expect(idx).toBeGreaterThan(-1);
  });

  it('no longer multiplies totalPrice directly by the BTC/JPY rate without the /1e8 conversion', () => {
    expect(src).not.toMatch(/Math\.round\(totalPrice \* satoshiToJPY\)/);
    expect(src).not.toMatch(/Math\.round\(totalPrice \* btcToJPY\)/);
  });
});
