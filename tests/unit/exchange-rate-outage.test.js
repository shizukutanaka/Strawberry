// tests/unit/exchange-rate-outage.test.js
//
// 上流の為替 API が**全滅している間**の振る舞い。
//
// きっかけ: 実サーバで各エンドポイントのレイテンシを測ったところ、GPU 一覧が 6ms の
// 一方で /api/exchange-rate だけが毎回 1.3〜1.65 秒かかっていた。原因は
// 「全プロバイダが失敗したことを覚えていない」こと。キャッシュが空のまま
// フォールバック値を返すので、次のリクエストもまた 4 本の API を順に叩いて
// 全部タイムアウトするまで待つ。結果として
//   (a) 上流障害が「1 リクエストが遅い」ではなく「全リクエストが遅い」に増幅され、
//   (b) 弱っている上流をリクエスト数のまま叩き続けてレート制限を踏み、復旧を遅らせる。
// SWR（tests/unit/exchange-rate-swr.test.js）はキャッシュが**ある**場合を守るが、
// キャッシュが空の場合はこの経路に落ちる。
jest.mock('axios');
const axios = require('axios');

const er = require('../../src/utils/exchange-rate');
const { getBTCtoJPYRate } = er;

const GOOD_RATE = 7_000_000;

beforeEach(() => {
  jest.clearAllMocks();
  er._resetCacheForTest();
});

describe('all providers down, cold cache', () => {
  it('stops re-probing upstream during the cooldown', async () => {
    axios.get.mockRejectedValue(new Error('network down'));

    await getBTCtoJPYRate();
    const afterFirst = axios.get.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0); // 1 回目は当然叩く

    await getBTCtoJPYRate();
    await getBTCtoJPYRate();
    // 冷却中は上流を一切叩かない
    expect(axios.get.mock.calls.length).toBe(afterFirst);
    expect(er._isInCooldownForTest()).toBe(true);
  });

  it('still returns a usable value while in cooldown (outside production)', async () => {
    axios.get.mockRejectedValue(new Error('network down'));
    await getBTCtoJPYRate();
    const rate = await getBTCtoJPYRate();
    expect(typeof rate).toBe('number');
    expect(rate).toBe(er.DEFAULT_RATE);
  });

  it('retries upstream once the cooldown expires', async () => {
    axios.get.mockRejectedValue(new Error('network down'));
    await getBTCtoJPYRate();
    const afterFirst = axios.get.mock.calls.length;

    await new Promise((r) => setTimeout(r, er.FAILURE_COOLDOWN_MS + 50));
    axios.get.mockResolvedValue({ data: { bitcoin: { jpy: GOOD_RATE } } });
    const rate = await getBTCtoJPYRate();

    expect(axios.get.mock.calls.length).toBeGreaterThan(afterFirst);
    expect(rate).toBe(GOOD_RATE);
    expect(er._isInCooldownForTest()).toBe(false);
  });

  it('an admin force-refresh is not blocked by the cooldown', async () => {
    // 冷却は自動リクエストの暴走を止めるためのもので、運用者が明示的に
    // 「今すぐ取り直す」と言った操作まで無効化してはいけない。
    axios.get.mockRejectedValue(new Error('network down'));
    await getBTCtoJPYRate();
    const afterFirst = axios.get.mock.calls.length;

    axios.get.mockResolvedValue({ data: { bitcoin: { jpy: GOOD_RATE } } });
    const rate = await getBTCtoJPYRate(true);
    expect(axios.get.mock.calls.length).toBeGreaterThan(afterFirst);
    expect(rate).toBe(GOOD_RATE);
  });
});

describe('cold-start thundering herd', () => {
  it('collapses concurrent cold requests into a single upstream fetch', async () => {
    // 起動直後に N 人が同時にアクセスしただけで上流へ N×4 本飛ぶのを防ぐ。
    let resolveFetch;
    axios.get.mockImplementation(() => new Promise((resolve) => {
      resolveFetch = () => resolve({ data: { bitcoin: { jpy: GOOD_RATE } } });
    }));

    const inFlight = [getBTCtoJPYRate(), getBTCtoJPYRate(), getBTCtoJPYRate(), getBTCtoJPYRate()];
    await new Promise((r) => setTimeout(r, 20));
    expect(axios.get.mock.calls.length).toBe(1);

    resolveFetch();
    const rates = await Promise.all(inFlight);
    expect(rates).toEqual([GOOD_RATE, GOOD_RATE, GOOD_RATE, GOOD_RATE]);
  });
});

describe('a warm cache is unaffected by the cooldown', () => {
  it('keeps serving the cached rate and never reaches the cold path', async () => {
    er._setCacheForTest(GOOD_RATE, Date.now());
    axios.get.mockRejectedValue(new Error('network down'));
    const rate = await getBTCtoJPYRate();
    expect(rate).toBe(GOOD_RATE);
    expect(axios.get).not.toHaveBeenCalled();
    expect(er._isInCooldownForTest()).toBe(false);
  });
});
