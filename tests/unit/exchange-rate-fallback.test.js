// tests/unit/exchange-rate-fallback.test.js
// exchange-rate.js のフォールバックチェーン — tests/unit/exchange-rate-swr.test.js が
// SWR 挙動をカバーするのに対し、こちらは「全プロバイダ失敗時」の経路を固定する。
// （旧 test_exchange_rate.js はファイル名が jest testMatch に合わず常時スキップされ、
// かつ assert で実 API を呼んでいた。オフラインかつ NODE_ENV 分岐を正しく検証する形へ修正。）
jest.mock('axios');
const axios = require('axios');
const er = require('../../src/utils/exchange-rate');
const { getBTCtoJPYRate } = er;

const SAVED_ENV = process.env.NODE_ENV;
beforeEach(() => {
  er._resetCacheForTest();
  axios.get.mockReset();
  process.env.NODE_ENV = 'test';
});
afterEach(() => { process.env.NODE_ENV = SAVED_ENV; });

describe('exchange-rate fallback chain', () => {
  it('cold cache + 全API失敗 → 非 production では DEFAULT_RATE を返す', async () => {
    axios.get.mockRejectedValue(new Error('network down'));
    const rate = await getBTCtoJPYRate();
    expect(rate).toBe(er.DEFAULT_RATE);
    // 4 プロバイダすべて試行される
    expect(axios.get).toHaveBeenCalledTimes(4);
  });

  it('cold cache + 全API失敗 → production では throw する', async () => {
    process.env.NODE_ENV = 'production';
    axios.get.mockRejectedValue(new Error('network down'));
    await expect(getBTCtoJPYRate()).rejects.toThrow('Exchange rate unavailable');
  });

  it('stale cache + 全API失敗 → stale 値を返す（DEFAULT_RATE より実レート優先）', async () => {
    const STALE = 8_000_000;
    er._setCacheForTest(STALE, Date.now() - (er.CACHE_MS + 60_000));
    // バックグラウンド更新が全失敗しても stale は維持される
    axios.get.mockRejectedValue(new Error('network down'));
    const rate = await getBTCtoJPYRate(true); // force: 同期 fetch → 失敗 → stale serve
    expect(rate).toBe(STALE);
  });

  it('coingecko 失敗 → cryptocompare にフォールバックする', async () => {
    axios.get
      .mockRejectedValueOnce(new Error('coingecko down'))
      .mockResolvedValueOnce({ data: { JPY: 7_000_000 } });
    const rate = await getBTCtoJPYRate();
    expect(rate).toBe(7_000_000);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('範囲外レート（<100000 or >15000000）は無効として次のプロバイダへ', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { bitcoin: { jpy: 50 } } })   // 範囲外 → reject
      .mockResolvedValueOnce({ data: { JPY: 7_000_000 } });        // 正常
    const rate = await getBTCtoJPYRate();
    expect(rate).toBe(7_000_000);
  });

  it('withTimestamp=true でメタ情報を返す', async () => {
    axios.get.mockResolvedValueOnce({ data: { bitcoin: { jpy: 6_500_000 } } });
    const res = await getBTCtoJPYRate(false, true);
    expect(res).toMatchObject({ rate: 6_500_000, isCache: false });
    expect(typeof res.timestamp).toBe('number');
  });
});
