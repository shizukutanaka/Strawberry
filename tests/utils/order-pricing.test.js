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
