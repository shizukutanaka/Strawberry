// order-pricing.js の金額計算不変条件を固定するテスト。
// - 価格ロック: 作成時に確定した totalPrice が権威（プロバイダの事後改価を支払額に
//   反映させない）。未保存のレガシー注文のみ単価×時間で再計算する。
// - 端数: sats 計算の浮動小数点ドリフトを Math.round + 最小1sat で防ぐ。
// - JPY 換算: totalPrice は satoshi なので 1e8 で BTC へ正規化してから乗算する
//   （1 sat を JPY/BTC レートへ直接掛けると1e8倍の誤表示になる）。レート欠損時は
//   NaN をフィールドへ書かず null 化する。
const GpuRepository = require('../../src/db/json/GpuRepository');
const { resolvePricePerHour, computeOrderPricing } = require('../../src/utils/order-pricing');

describe('resolvePricePerHour', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  test('注文側 pricePerHour を最優先に採用する', () => {
    expect(resolvePricePerHour({ pricePerHour: 100, maxPricePerHour: 200 })).toBe(100);
  });

  test('pricePerHour が無い場合は maxPricePerHour へフォールバックする', () => {
    expect(resolvePricePerHour({ maxPricePerHour: 200 })).toBe(200);
  });

  test('単価未設定の注文は対象GPUの現在単価へフォールバックする', () => {
    jest.spyOn(GpuRepository, 'getById').mockReturnValue({ id: 'g1', pricePerHour: 300 });
    expect(resolvePricePerHour({ gpuId: 'g1' })).toBe(300);
  });

  test('GPU 未登録・単価未設定なら 0', () => {
    jest.spyOn(GpuRepository, 'getById').mockReturnValue(null);
    expect(resolvePricePerHour({ gpuId: 'missing' })).toBe(0);
    expect(resolvePricePerHour({})).toBe(0);
  });
});

describe('computeOrderPricing', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  test('保存済み totalPrice を権威値として再計算に優先する（価格ロック）', () => {
    // 単価から再計算すると 50 sats になるが、保存値 30 sats がそのまま使われる。
    const p = computeOrderPricing({ pricePerHour: 100, durationMinutes: 30, totalPrice: 30 });
    expect(p.totalPrice).toBe(30);
    expect(p.pricePerHour).toBe(100);
  });

  test('totalPrice 未保存のレガシー注文は 5分単価 × 枠数で再計算する', () => {
    // 100 sats/h → 5分あたり 8.333… → 30分(6枠) = 50 sats（時間の半分）
    const p = computeOrderPricing({ pricePerHour: 100, durationMinutes: 30 });
    expect(p.totalPrice).toBe(50);
    expect(p.pricePer5Min).toBeCloseTo(100 / 12, 10);
  });

  test('1sat 未満の端数は切り上げず最小 1sat とする（raw>0）', () => {
    // 1 sats/h × 5分 = 1/12 ≈ 0.083 → Math.round=0 だが支払額 0 にしない
    const p = computeOrderPricing({ pricePerHour: 1, durationMinutes: 5 });
    expect(p.totalPrice).toBe(1);
  });

  test('ゼロ条件（無料・時間0）は totalPrice=0', () => {
    expect(computeOrderPricing({ pricePerHour: 0, durationMinutes: 60 }).totalPrice).toBe(0);
    expect(computeOrderPricing({ pricePerHour: 100, durationMinutes: 0 }).totalPrice).toBe(0);
  });

  test('JPY 換算は sat→BTC 正規化してから乗算する', () => {
    // 1 BTC = 1e8 sat。1,000,000 sat = 0.01 BTC × 10,000,000 JPY/BTC = 100,000 JPY
    const p = computeOrderPricing(
      { pricePerHour: 0, durationMinutes: 0, totalPrice: 1_000_000 },
      { rate: 10_000_000, timestamp: '2026-01-01T00:00:00Z' }
    );
    expect(p.totalPriceJPY).toBe(100_000);
    expect(p.exchangeRateTimestamp).toBe('2026-01-01T00:00:00Z');
  });

  test('レートが NaN/Infinity のとき totalPriceJPY は null（NaN を書かない）', () => {
    for (const rate of [NaN, Infinity, -Infinity]) {
      const p = computeOrderPricing(
        { totalPrice: 1_000_000 },
        { rate, timestamp: '2026-01-01T00:00:00Z' }
      );
      expect(p.totalPriceJPY).toBeNull();
    }
  });

  test('rateInfo 未指定では JPY フィールドを含めない', () => {
    const p = computeOrderPricing({ totalPrice: 100 });
    expect('totalPriceJPY' in p).toBe(false);
    expect('exchangeRateTimestamp' in p).toBe(false);
  });
});

// 弱所#37 — satoshi 整数演算のプロパティテスト（値例ではなく全域の不変条件）
describe('プロパティ不変条件（satoshi 整数演算の全域検査）', () => {
  // 代表的単価域 × 全 durationMinutes 格子（5 の倍数・Joi 上限 43200 含む端点）
  const PRICES = [0.00001, 0.1, 1, 12, 100, 999.99, 1000, 100000, 999999.5];
  const DURATIONS = [5, 10, 15, 30, 55, 60, 120, 1440, 43200];

  test('totalPrice は常に非負の整数 sat（NaN・小数・負値を生成しない）', () => {
    for (const pricePerHour of PRICES) {
      for (const durationMinutes of DURATIONS) {
        const { totalPrice } = computeOrderPricing({ pricePerHour, durationMinutes });
        expect(Number.isInteger(totalPrice)).toBe(true);
        expect(totalPrice).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('正の生額は最小 1 sat に切り上げ（1sat フロア — 0 sat 支払い不能を防ぐ）', () => {
    for (const pricePerHour of PRICES.filter((p) => p > 0)) {
      for (const durationMinutes of DURATIONS) {
        const { totalPrice } = computeOrderPricing({ pricePerHour, durationMinutes });
        expect(totalPrice).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test('durationMinutes に対し単調非減少（長い予約が安くなることはない）', () => {
    const sorted = [...DURATIONS].sort((a, b) => a - b);
    for (const pricePerHour of PRICES) {
      let prev = -1;
      for (const durationMinutes of sorted) {
        const { totalPrice } = computeOrderPricing({ pricePerHour, durationMinutes });
        expect(totalPrice).toBeGreaterThanOrEqual(prev);
        prev = totalPrice;
      }
    }
  });

  test('価格ロック: totalPrice 保存済み注文は単価・時間の変更を受けない', () => {
    for (const totalPrice of [1, 100, 123456789]) {
      const p = computeOrderPricing({ totalPrice, pricePerHour: 0.001, durationMinutes: 5 });
      expect(p.totalPrice).toBe(totalPrice);
    }
  });

  test('totalPriceJPY は整数 or null（NaN を絶対に書かない）全域', () => {
    const rates = [1, 1000, 5_000_000, 10_000_000, 999_999_999, NaN, Infinity, -Infinity, 0];
    for (const rate of rates) {
      const p = computeOrderPricing(
        { totalPrice: 123_456_789 },
        { rate, timestamp: '2026-01-01T00:00:00Z' }
      );
      if (p.totalPriceJPY === null) continue;
      expect(Number.isInteger(p.totalPriceJPY)).toBe(true);
      expect(p.totalPriceJPY).toBeGreaterThanOrEqual(0);
    }
  });
});
