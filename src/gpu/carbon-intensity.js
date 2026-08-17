// src/gpu/carbon-intensity.js
// 地域の系統カーボン強度に基づく排出量推定（docs/improvement-research-2026.md §15）。
//
// 現状の Strawberry は GPU が地理的に分散しているのに、配置の判断材料が価格と性能しか無い。
// 出品には `location { country, region, ... }` があるが**国フィルタ以外に一切使われていない**。
// 遅延に敏感でないバッチ学習は低炭素地域へ寄せられるはずで、そこは機会損失になっている。
//
// 関連ソフトウェア:
//   - Google の carbon-intelligent computing（系統のカーボン強度に応じて時間・地域で
//     バッチ負荷をシフトする）
//   - ElectricityMaps / WattTime（地域別のリアルタイム・限界カーボン強度 API）
//   - AWS/GCP/Azure のカーボンフットプリント・ダッシュボード
//
// 参考研究:
//   - SLIT: Sustainable Carbon-Aware and Water-Efficient LLM Scheduling in Geo-Distributed
//     Cloud Datacenters, arXiv:2505.23554 — TTFT・カーボン・水・電力コストの共最適化。
//   - Carbon-Aware Computing with Probabilistic Performance Guarantees, arXiv:2410.21510。
//   - Task Scheduling in Geo-Distributed Computing: A Survey, arXiv:2501.15504。
//
// --- 正直さの要件（この機能の失敗モードはグリーンウォッシング）-----------------
// 1. **所在地は自己申告で未検証**。プロバイダは実際にはポーランドで動かしながら
//    「ノルウェー」と申告できる。したがって本モジュールの出力は常に
//    「申告された所在地に基づく推定」であり、検証済みの環境価値ではない。
//    confidence を必ず添え、UI もそう表示すること。
// 2. **年間平均であってリアルタイムの限界強度ではない**。実際の排出は時間帯・気象で
//    数倍変動する。厳密な値が要るなら ElectricityMaps 等の実データを差し込む必要がある
//    （下の `setIntensityProvider()` がその差込口。既定は静的表）。
// 3. 分からない地域は推測しない。`null` を返し、UI は「不明」と表示する
//    （世界平均で埋めると、実際には高炭素の地域が中庸に見えてしまう）。
//
// 純関数＋差込可能なプロバイダのみ。外部通信は行わない。

// 系統のカーボン強度（gCO2eq/kWh、発電ベースの概算年間平均）。
// 出典は公開統計（IEA / Ember / 各国系統運用者）の桁感で、**順位付けと概算のための近似**。
// 精密な報告用途には実データ API を差し込むこと。
const COUNTRY_INTENSITY = {
  IS: 28, NO: 30, SE: 45, CH: 45, FR: 85, BR: 110, AT: 130, FI: 130,
  CA: 150, BE: 170, ES: 170, DK: 180, PT: 200, UK: 240, GB: 240,
  NZ: 250, IT: 330, NL: 330, CL: 330, RU: 360, US: 370, AR: 350,
  MX: 430, SG: 410, AE: 400, DE: 380, KR: 440, TR: 440, JP: 490,
  AU: 530, TW: 560, CN: 580, SA: 600, ID: 650, PL: 660, IN: 700, ZA: 700,
};

// 国内の差が大きい地域はサブリージョンを持つ（米国の州は 90〜750 と 8 倍以上開く。
// 「US」で一律 370 とすると、ワシントン州の水力とウェストバージニア州の石炭が同点になる）。
const REGION_INTENSITY = {
  'US-WA': 90, 'US-OR': 130, 'US-ID': 110, 'US-VT': 30, 'US-NY': 210,
  'US-CA': 230, 'US-NV': 350, 'US-IL': 350, 'US-TX': 400, 'US-GA': 380,
  'US-OH': 550, 'US-IN': 650, 'US-KY': 700, 'US-WV': 750, 'US-WY': 720,
  'CA-QC': 30, 'CA-BC': 40, 'CA-ON': 90, 'CA-AB': 530, 'CA-SK': 620,
  'CN-SC': 200, 'CN-XJ': 640, 'CN-IM': 700,
  'AU-TAS': 150, 'AU-SA': 250, 'AU-QLD': 630, 'AU-VIC': 700,
};

// データセンター電力使用効率（PUE）。GPU 自体の消費に加えて冷却・変換損失がかかる。
// ハイパースケールは 1.1 前後、一般的な事業者は 1.4〜1.6。P2P の出品は自宅〜小規模施設が
// 多いと見て中間の 1.2 を既定にする。過小評価を避けたい場合は呼び出し側で上書きする。
const DEFAULT_PUE = 1.2;

// 強度のティア境界（gCO2eq/kWh）。UI の色分けと「グリーン」表示の基準。
const TIERS = [
  { max: 100, tier: 'very_low' },
  { max: 250, tier: 'low' },
  { max: 450, tier: 'moderate' },
  { max: 650, tier: 'high' },
  { max: Infinity, tier: 'very_high' },
];

// 実データ API（ElectricityMaps / WattTime 等）の差込口。
// 既定は null＝静的表のみ。設定すると (location) => number|null を呼んで実測値を優先する。
let _intensityProvider = null;

/**
 * リアルタイム強度プロバイダを差し込む（省略時は静的表）。
 * @param {null|((location:object)=>number|null)} fn
 */
function setIntensityProvider(fn) {
  _intensityProvider = typeof fn === 'function' ? fn : null;
}

function normalizeCountry(c) {
  return typeof c === 'string' ? c.trim().toUpperCase() : null;
}

/**
 * 所在地からカーボン強度を引く。
 * サブリージョン（例 US-WA）を優先し、無ければ国、いずれも無ければ null。
 *
 * @param {object} location { country, region }
 * @returns {{gCO2PerKWh:number|null, matched:string|null, granularity:'region'|'country'|'live'|null, confidence:string}}
 */
function lookupIntensity(location = {}) {
  // 実データが差し込まれていればそちらを優先する（年間平均より常に正確）。
  if (_intensityProvider) {
    try {
      const live = _intensityProvider(location);
      if (typeof live === 'number' && Number.isFinite(live) && live >= 0) {
        return { gCO2PerKWh: live, matched: 'live', granularity: 'live', confidence: 'measured-grid' };
      }
    } catch (_) { /* 実データ取得の失敗で推定全体を止めない */ }
  }

  const country = normalizeCountry(location.country);
  if (!country) return { gCO2PerKWh: null, matched: null, granularity: null, confidence: 'unknown' };

  const region = typeof location.region === 'string' ? location.region.trim().toUpperCase() : null;
  if (region) {
    // "US-WA" 形式と、country="US" / region="WA" の両方を受ける
    const key = region.startsWith(`${country}-`) ? region : `${country}-${region}`;
    if (REGION_INTENSITY[key] !== undefined) {
      return {
        gCO2PerKWh: REGION_INTENSITY[key], matched: key, granularity: 'region',
        // 所在地そのものが自己申告なので、粒度が細かくても「検証済み」にはならない
        confidence: 'self-declared-location',
      };
    }
  }
  if (COUNTRY_INTENSITY[country] !== undefined) {
    return {
      gCO2PerKWh: COUNTRY_INTENSITY[country], matched: country, granularity: 'country',
      confidence: 'self-declared-location',
    };
  }
  // 未知の地域を世界平均で埋めない（高炭素地域が中庸に見えてしまう）
  return { gCO2PerKWh: null, matched: null, granularity: null, confidence: 'unknown' };
}

/** 強度からティアを求める。 */
function intensityTier(gCO2PerKWh) {
  if (typeof gCO2PerKWh !== 'number' || !Number.isFinite(gCO2PerKWh) || gCO2PerKWh < 0) return null;
  return TIERS.find((t) => gCO2PerKWh < t.max).tier;
}

/**
 * 稼働に伴う推定 CO2 排出量（グラム）。
 * @param {object} input { powerWatt, hours, gCO2PerKWh, pue }
 * @returns {number|null}
 */
function estimateEmissionsGrams({ powerWatt, hours, gCO2PerKWh, pue = DEFAULT_PUE } = {}) {
  // 型強制をしない。`Number(null)` は 0 なので、強度が不明（null）な出品が
  // 「排出ゼロ＝最もグリーン」として通ってしまう。この機能の失敗モードそのもの。
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const [w, h, ci, p] = [powerWatt, hours, gCO2PerKWh, pue];
  if (![w, h, ci, p].every(isNum) || w < 0 || h < 0 || ci < 0 || p <= 0) return null;
  const kWh = (w / 1000) * h * p;
  return Math.round(kWh * ci * 10) / 10;
}

/**
 * 出品レコードから、API/UI にそのまま載せられるカーボン・サマリを作る。
 * 排出量は「1 時間あたり」で出す（注文の長さに依らず比較できるため）。
 *
 * @param {object} gpu { powerWatt, location }
 * @param {object} opts { pue }
 * @returns {{gCO2PerKWh, tier, matched, granularity, confidence, gramsPerHour, pue}}
 */
function summarize(gpu = {}, { pue = DEFAULT_PUE } = {}) {
  const looked = lookupIntensity(gpu.location || {});
  const gramsPerHour = looked.gCO2PerKWh == null
    ? null
    : estimateEmissionsGrams({ powerWatt: gpu.powerWatt, hours: 1, gCO2PerKWh: looked.gCO2PerKWh, pue });
  return {
    gCO2PerKWh: looked.gCO2PerKWh,
    tier: intensityTier(looked.gCO2PerKWh),
    matched: looked.matched,
    granularity: looked.granularity,
    confidence: looked.confidence,
    gramsPerHour,
    pue,
  };
}

module.exports = {
  lookupIntensity,
  intensityTier,
  estimateEmissionsGrams,
  summarize,
  setIntensityProvider,
  COUNTRY_INTENSITY,
  REGION_INTENSITY,
  DEFAULT_PUE,
};
