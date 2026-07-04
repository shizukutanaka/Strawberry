// tests/unit/exchange-rate-swr.test.js
//
// Verifies the stale-while-revalidate (SWR) behavior of getBTCtoJPYRate().
//
// Motivation (found via profiling this session): the BTC/JPY rate is fetched on
// the critical path of order creation, order listing, payment creation, and GPU
// estimates (order/index.js, payment/index.js, gpu/index.js all `await
// fetchRateInfo()`). The rate cache has a 5-minute TTL, and the OLD implementation
// re-fetched synchronously on every cache miss — meaning the first request after
// each TTL expiry blocked on up to 4 sequential external API calls (up to ~16s if
// all timed out) before responding. A `Slow response: POST /api/v1/orders -
// 1322ms` warning was observed live, caused by exactly this (4 sequential
// exchange-rate API failures on the order-creation path).
//
// The JPY figure is display-only (the actual order/payment amount is in sats), so
// a core write path must not block on this non-critical external dependency. SWR
// fixes it: an expired-but-present rate is served immediately and refreshed in the
// background (deduplicated), so these hot paths never block on external APIs once
// the cache is warm.

jest.mock('axios');
const axios = require('axios');

const er = require('../../src/utils/exchange-rate');
const { getBTCtoJPYRate } = er;

const STALE_RATE = 5_000_000;
const FRESH_RATE = 6_000_000;

function coingeckoResponse(rate) {
  return { data: { bitcoin: { jpy: rate } } };
}

async function waitFor(cond, timeoutMs = 2000) {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  er._resetCacheForTest();
  axios.get.mockReset();
});

describe('exchange-rate stale-while-revalidate', () => {
  it('serves a stale cached rate IMMEDIATELY without blocking on the external API', async () => {
    // Stale cache: present but older than the TTL.
    er._setCacheForTest(STALE_RATE, Date.now() - (er.CACHE_MS + 60_000));

    // Make the external API hang (never resolves during the synchronous call).
    let resolveAxios;
    axios.get.mockImplementation(() => new Promise((res) => { resolveAxios = res; }));

    const t0 = Date.now();
    const result = await getBTCtoJPYRate(false, true);
    const elapsed = Date.now() - t0;

    // Returned the stale value without waiting for the (still-pending) fetch.
    expect(result.rate).toBe(STALE_RATE);
    expect(result.isCache).toBe(true);
    expect(elapsed).toBeLessThan(100);

    // Let the background refresh settle so it doesn't leak as an open handle.
    resolveAxios(coingeckoResponse(FRESH_RATE));
    await waitFor(() => er._getCacheForTest().rate === FRESH_RATE);
  });

  it('updates the cache in the background after serving stale', async () => {
    er._setCacheForTest(STALE_RATE, Date.now() - (er.CACHE_MS + 60_000));
    axios.get.mockResolvedValue(coingeckoResponse(FRESH_RATE));

    const first = await getBTCtoJPYRate(false, true);
    expect(first.rate).toBe(STALE_RATE); // stale served first

    // Background refresh eventually replaces the cached value.
    await waitFor(() => er._getCacheForTest().rate === FRESH_RATE);
    expect(er._getCacheForTest().rate).toBe(FRESH_RATE);

    // A subsequent call now returns the freshly-refreshed rate from cache.
    const second = await getBTCtoJPYRate(false, true);
    expect(second.rate).toBe(FRESH_RATE);
    expect(second.isCache).toBe(true);
  });

  it('deduplicates concurrent background refreshes into a single in-flight fetch', async () => {
    er._setCacheForTest(STALE_RATE, Date.now() - (er.CACHE_MS + 60_000));

    let resolveAxios;
    axios.get.mockImplementation(() => new Promise((res) => { resolveAxios = res; }));

    // Fire many stale-serving calls before the refresh resolves.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getBTCtoJPYRate(false, true))
    );
    // All five got the stale value immediately.
    for (const r of results) expect(r.rate).toBe(STALE_RATE);

    // Only ONE background refresh started -> the (successful) first provider was
    // hit exactly once, not five times.
    expect(axios.get).toHaveBeenCalledTimes(1);

    resolveAxios(coingeckoResponse(FRESH_RATE));
    await waitFor(() => er._getCacheForTest().rate === FRESH_RATE);
  });

  it('fresh cache is served immediately with NO external call', async () => {
    er._setCacheForTest(FRESH_RATE, Date.now()); // fresh (just now)
    axios.get.mockResolvedValue(coingeckoResponse(999_999));

    const result = await getBTCtoJPYRate(false, true);
    expect(result.rate).toBe(FRESH_RATE);
    expect(result.isCache).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('cold cache blocks and fetches synchronously (isCache=false)', async () => {
    er._resetCacheForTest();
    axios.get.mockResolvedValue(coingeckoResponse(FRESH_RATE));

    const result = await getBTCtoJPYRate(false, true);
    expect(result.rate).toBe(FRESH_RATE);
    expect(result.isCache).toBe(false);
    expect(axios.get).toHaveBeenCalled();
  });

  it('force=true bypasses even a fresh cache and fetches synchronously', async () => {
    er._setCacheForTest(STALE_RATE, Date.now()); // fresh cache present
    axios.get.mockResolvedValue(coingeckoResponse(FRESH_RATE));

    const result = await getBTCtoJPYRate(true, true); // force
    expect(result.rate).toBe(FRESH_RATE); // fetched, not the cached STALE_RATE
    expect(result.isCache).toBe(false);
    expect(axios.get).toHaveBeenCalled();
  });

  it('force=true that fails falls back to the existing (stale-on-error) cache', async () => {
    er._setCacheForTest(STALE_RATE, Date.now() - (er.CACHE_MS + 60_000));
    axios.get.mockRejectedValue(new Error('network down'));

    const result = await getBTCtoJPYRate(true, true);
    expect(result.rate).toBe(STALE_RATE); // served stale on error
    expect(result.isCache).toBe(true);
  });
});
