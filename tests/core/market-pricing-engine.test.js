// market-pricing-engine.js の価格計算不変条件とデーモンタイマー契約を固定するテスト。
// estimate ルートで advisory 参照価格として配線済みだが直接テストが無かった。
// - 係数ファミリー（需給/時間帯/品質/期間/地域）の境界値とフォールバック
// - getGPUSpecs の一致ルール（完全一致 > 部分一致 > null — 未一致に合成スペックを
//   返すと未知モデルへ「実測相当」価格が出るため null を固定）
// - calculateGPUPrice: 価格帯クランプ・期間ティア乗数・price-calculated イベント・統計
// - startPeriodicUpdates: unref 済み・再初期化で多重化しない・stop で解除
const { MarketPricingEngine } = require('../../src/core/market-pricing-engine');

let engine;
beforeEach(() => { engine = new MarketPricingEngine(); });
afterEach(() => { engine.stopPeriodicUpdates(); });

describe('getGPUSpecs', () => {
  test('完全一致で性能マップを返す', () => {
    expect(engine.getGPUSpecs('RTX 4090').tflops).toBeCloseTo(82.58);
  });

  test('部分一致も許容する（ベンダー名付き表記など）', () => {
    const specs = engine.getGPUSpecs('NVIDIA RTX 4090 SUPER');
    expect(specs).toBeTruthy();
    expect(specs.vram).toBe(24576);
  });

  test('未知モデル・非文字列は null（合成スペックを返さない）', () => {
    expect(engine.getGPUSpecs('H100 NVL')).toBeNull();
    expect(engine.getGPUSpecs(null)).toBeNull();
    expect(engine.getGPUSpecs(123)).toBeNull();
  });
});

describe('係数ファミリー', () => {
  test('calculateSupplyDemandFactor: 需要過多は最大+50%でクランプ', () => {
    expect(engine.calculateSupplyDemandFactor(10, 1)).toBe(1.5); // ratio 10 → cap
    expect(engine.calculateSupplyDemandFactor(4, 1)).toBeCloseTo(1.5); // ratio 4 → 1+min(0.5,0.5)
  });

  test('calculateSupplyDemandFactor: 供給過多は 0.7 床付き線形', () => {
    expect(engine.calculateSupplyDemandFactor(0, 10)).toBeCloseTo(0.7); // ratio 0 → 床
    expect(engine.calculateSupplyDemandFactor(0.25, 1)).toBeCloseTo(0.7 + 0.25 * 0.6);
  });

  test('calculateSupplyDemandFactor: バランス域は 0.9+ratio*0.1', () => {
    expect(engine.calculateSupplyDemandFactor(1, 1)).toBeCloseTo(1.0);
    expect(engine.calculateSupplyDemandFactor(1.5, 1)).toBeCloseTo(1.05);
  });

  test('calculateTimeFactor: 帯域境界が仕様どおり', () => {
    expect(engine.calculateTimeFactor(9)).toBe(1.2);   // ビジネスアワー開始
    expect(engine.calculateTimeFactor(17)).toBe(1.2);  // 同終了
    expect(engine.calculateTimeFactor(18)).toBe(1.0);
    expect(engine.calculateTimeFactor(19)).toBe(1.1);  // プライムタイム
    expect(engine.calculateTimeFactor(23)).toBe(1.1);
    expect(engine.calculateTimeFactor(2)).toBe(0.8);   // 深夜
    expect(engine.calculateTimeFactor(6)).toBe(0.8);
    expect(engine.calculateTimeFactor(0)).toBe(1.0);
  });

  test('calculateQualityFactor: 0-100 を 0.8-1.2 へ写像', () => {
    expect(engine.calculateQualityFactor(0)).toBeCloseTo(0.8);
    expect(engine.calculateQualityFactor(50)).toBeCloseTo(1.0);
    expect(engine.calculateQualityFactor(100)).toBeCloseTo(1.2);
  });

  test('calculateDurationDiscount: 長期ティア境界', () => {
    expect(engine.calculateDurationDiscount(1)).toBe(1.0);
    expect(engine.calculateDurationDiscount(8)).toBe(0.98);
    expect(engine.calculateDurationDiscount(24)).toBe(0.95);
    expect(engine.calculateDurationDiscount(168)).toBe(0.85);
    expect(engine.calculateDurationDiscount(720)).toBe(0.70);
  });

  test('calculateRegionFactor: 未知リージョンは US-EAST へフォールバック', () => {
    expect(engine.calculateRegionFactor('MOON')).toBe(engine.calculateRegionFactor('US-EAST'));
  });
});

describe('calculateGPUPrice', () => {
  test('未知モデルは警告付きデフォルト価格を返す', () => {
    const r = engine.calculateGPUPrice('NoSuchGPU-9000');
    expect(r.gpuModel).toBe('Unknown');
    expect(r.price.hourly).toBe(0.30);
  });

  test('価格は [floor, ceiling] にクランプされる', () => {
    const r = engine.calculateGPUPrice('RTX 4090', {
      qualityScore: 100, demandLevel: 10, supplyLevel: 1, timeOfDay: 12,
    });
    expect(r.price.hourly).toBeLessThanOrEqual(engine.config.priceCeiling);
    expect(r.price.hourly).toBeGreaterThanOrEqual(engine.config.priceFloor);
  });

  test('期間ティアは hourly の 0.95/0.85/0.70 乗数', () => {
    const r = engine.calculateGPUPrice('RTX 3090', { timeOfDay: 3, qualityScore: 50 });
    expect(r.price.daily).toBeCloseTo(r.price.hourly * 24 * 0.95, 6);
    expect(r.price.weekly).toBeCloseTo(r.price.hourly * 168 * 0.85, 6);
    expect(r.price.monthly).toBeCloseTo(r.price.hourly * 720 * 0.70, 6);
  });

  test('price-calculated イベント発火と統計更新', () => {
    const seen = [];
    engine.on('price-calculated', (r) => seen.push(r));
    engine.calculateGPUPrice('RTX 3090');
    engine.calculateGPUPrice('RTX 3090');
    expect(seen).toHaveLength(2);
    expect(engine.statistics.totalCalculations).toBe(2);
    expect(engine.statistics.priceRange.min).toBe(engine.statistics.priceRange.max);
  });
});

describe('predictEarnings / recommendPrice', () => {
  test('プラットフォーム手数料 1.5% で net = gross * 0.985', () => {
    const e = engine.predictEarnings('RTX 3090', 10, { timeOfDay: 12 });
    expect(e.platformFee).toBeCloseTo(e.gross * 0.015, 10);
    expect(e.net).toBeCloseTo(e.gross * 0.985, 10);
  });

  test('recommendPrice: 高稼働率要求なら premium（+10%）、低なら competitive（-10%）', () => {
    const hi = engine.recommendPrice('RTX 3090', 100000, { timeOfDay: 12 });
    expect(hi.strategy).toBe('premium');
    expect(hi.recommendedPrice).toBeCloseTo(hi.currentPrice * 1.1);
    const lo = engine.recommendPrice('RTX 3090', 1, { timeOfDay: 12 });
    expect(lo.strategy).toBe('competitive');
    expect(lo.recommendedPrice).toBeCloseTo(lo.currentPrice * 0.9);
  });
});

describe('定期更新タイマー', () => {
  test('startPeriodicUpdates はハンドルを保持し unref される', () => {
    engine.startPeriodicUpdates();
    expect(engine._periodicTimer).toBeTruthy();
    expect(engine._periodicTimer.hasRef()).toBe(false);
  });

  test('再呼出しでインターバルが多重化しない（旧タイマーを解除）', () => {
    const clearSpy = jest.spyOn(global, 'clearInterval');
    engine.startPeriodicUpdates();
    const first = engine._periodicTimer;
    engine.startPeriodicUpdates();
    expect(clearSpy).toHaveBeenCalledWith(first);
    expect(engine._periodicTimer).not.toBe(first);
    clearSpy.mockRestore();
  });

  test('stopPeriodicUpdates で解除され null に戻る', () => {
    engine.startPeriodicUpdates();
    engine.stopPeriodicUpdates();
    expect(engine._periodicTimer).toBeNull();
  });
});
