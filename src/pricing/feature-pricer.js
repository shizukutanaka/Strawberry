// src/pricing/feature-pricer.js
// 特徴量ベース GPU 価格付けエンジン（docs/category-research-2026.md カテゴリ4, 参考: Agora arXiv:2510.05111）。
// 現状の order/index.js は `pricePerHour/12` のフラット課金のみ。本モジュールは
// GPU 特徴量(VRAM/世代/メモリ帯域/ベンチ)と需給・腐敗性(spot idle)から公正な時給を算出する純関数。
// 既存の孤立 pricing engine の代替土台。インフラ非依存・テスト可能。

const GENERATION_SCORES = {
  volta: 0.6, turing: 0.7, ampere: 1.0, ada: 1.3, hopper: 2.0, blackwell: 2.6,
};

const DEFAULTS = {
  baseRatePerHour: 1000, // 参照GPU・需給均衡時の基準価格（単位は sats 等、呼び出し側で統一）
  reference: { vramGB: 24, memBandwidthGBs: 900, benchmarkScore: 100, generationScore: 1.0 },
  weights: { vram: 0.35, bandwidth: 0.2, benchmark: 0.35, generation: 0.1 },
  surgeSensitivity: 1.0,   // 需給による価格感度
  balancePoint: 0.5,       // この稼働率で需給均衡（multiplier=1）
  minDemandMultiplier: 0.7,
  maxDemandMultiplier: 2.5,
  spotIdleDiscount: 0.6,   // 腐敗性: 余りそうな spot 在庫は値下げして消化
  floorPerHour: 100,
  capPerHour: 1e9,
};

function num(v, def = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function generationScore(gpu) {
  if (typeof gpu.generationScore === 'number' && Number.isFinite(gpu.generationScore)) {
    return gpu.generationScore;
  }
  if (typeof gpu.generation === 'string') {
    return GENERATION_SCORES[gpu.generation.toLowerCase()] || 1.0;
  }
  return 1.0;
}

/**
 * GPU 1台の時給を算出する。
 * @param {object} gpu { vramGB, memBandwidthGBs, benchmarkScore, generation|generationScore }
 * @param {object} market { utilization?: [0,1], spotIdle?: boolean }
 * @param {object} opts DEFAULTS を上書き
 * @returns {{pricePerHour:number, pricePer5Min:number, breakdown:object}}
 */
function computePrice(gpu = {}, market = {}, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts,
    reference: { ...DEFAULTS.reference, ...(opts.reference || {}) },
    weights: { ...DEFAULTS.weights, ...(opts.weights || {}) },
  };
  const ref = cfg.reference;

  // 重み正規化（合計1でなくても安全）
  const wSum = num(cfg.weights.vram) + num(cfg.weights.bandwidth) + num(cfg.weights.benchmark) + num(cfg.weights.generation) || 1;
  const w = {
    vram: num(cfg.weights.vram) / wSum,
    bandwidth: num(cfg.weights.bandwidth) / wSum,
    benchmark: num(cfg.weights.benchmark) / wSum,
    generation: num(cfg.weights.generation) / wSum,
  };

  // 各特徴量を参照GPU比で正規化。参照GPUなら featureMultiplier ≈ 1。
  const rVram = Math.max(0, num(gpu.vramGB)) / Math.max(1e-9, num(ref.vramGB, 24));
  const rBw = Math.max(0, num(gpu.memBandwidthGBs)) / Math.max(1e-9, num(ref.memBandwidthGBs, 900));
  const rBench = Math.max(0, num(gpu.benchmarkScore)) / Math.max(1e-9, num(ref.benchmarkScore, 100));
  const rGen = generationScore(gpu) / Math.max(1e-9, num(ref.generationScore, 1));

  const featureMultiplier = w.vram * rVram + w.bandwidth * rBw + w.benchmark * rBench + w.generation * rGen;

  // 需給乗数: 稼働率が balancePoint より高ければ surge、低ければ割引。
  const utilization = clamp(num(market.utilization, cfg.balancePoint), 0, 1);
  const demandMultiplier = clamp(
    1 + cfg.surgeSensitivity * (utilization - cfg.balancePoint),
    cfg.minDemandMultiplier,
    cfg.maxDemandMultiplier
  );

  // 腐敗性: 余りそうな spot 在庫は値下げ（GPU 時間は貯蔵不能）。
  const perishabilityFactor = market.spotIdle ? clamp(num(cfg.spotIdleDiscount, 0.6), 0, 1) : 1;

  const raw = cfg.baseRatePerHour * featureMultiplier * demandMultiplier * perishabilityFactor;
  const pricePerHour = clamp(raw, cfg.floorPerHour, cfg.capPerHour);

  return {
    pricePerHour,
    pricePer5Min: pricePerHour / 12,
    breakdown: {
      baseRatePerHour: cfg.baseRatePerHour,
      featureMultiplier,
      demandMultiplier,
      perishabilityFactor,
      featureRatios: { vram: rVram, bandwidth: rBw, benchmark: rBench, generation: rGen },
    },
  };
}

module.exports = { computePrice, generationScore, GENERATION_SCORES, DEFAULTS };
