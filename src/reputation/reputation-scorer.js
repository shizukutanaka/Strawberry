// src/reputation/reputation-scorer.js
// ホスト(プロバイダ)レピュテーション・スコアラ（docs/category-research-2026.md カテゴリ5）。
// SLA・ジョブ成否・検証監査(カテゴリ1 work-verifier)・担保ステーク・スラッシングから
// [0,1] の信頼度スコアを算出する純関数。マッチング(カテゴリ4)の重み付けや
// 検索ランキング、エスクロー解放判断から利用することを想定。インフラ非依存・テスト可能。

function num(v, def = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * 低ボリュームのゲーミングを抑えるベイズ平滑化レート。
 * 実績が少ないほど事前平均(priorMean)へ寄り、新規プロバイダが満点を主張できないようにする。
 */
function bayesianRate(success, total, { priorMean = 0.8, priorWeight = 5 } = {}) {
  const s = Math.max(0, num(success));
  const t = Math.max(s, num(total));
  return (s + priorMean * priorWeight) / (t + priorWeight);
}

/**
 * ホストのレピュテーションを算出する。
 * @param {object} stats
 *   completedJobs, failedJobs        … 完了/失敗ジョブ数
 *   auditPasses, auditFails          … 再実行監査の合否（work-verifier 連携）
 *   slaUptimePct                     … 稼働率(%) 既定100
 *   interruptionRate                 … 中断率 [0,1] 既定0
 *   stake                            … 担保ステーク（sats 等）既定0
 *   slashCount                       … スラッシング回数 既定0
 * @param {object} opts weights/stakeRef/minStakeFactor/slashPenaltyPerEvent/priorMean/priorWeight
 * @returns {{score:number, tier:string, components:object}}
 */
function computeReputation(stats = {}, opts = {}) {
  const {
    weights: rawWeights = { jobSuccess: 0.4, verification: 0.4, reliability: 0.2 },
    stakeRef = 1_000_000,
    minStakeFactor = 0.5,
    slashPenaltyPerEvent = 0.2,
    priorMean = 0.8,
    priorWeight = 5,
  } = opts;

  // 重みを正規化（合計1でなくても安全に）
  const wSum =
    num(rawWeights.jobSuccess) + num(rawWeights.verification) + num(rawWeights.reliability) || 1;
  const weights = {
    jobSuccess: num(rawWeights.jobSuccess) / wSum,
    verification: num(rawWeights.verification) / wSum,
    reliability: num(rawWeights.reliability) / wSum,
  };

  const completed = Math.max(0, num(stats.completedJobs));
  const failed = Math.max(0, num(stats.failedJobs));
  const auditPasses = Math.max(0, num(stats.auditPasses));
  const auditFails = Math.max(0, num(stats.auditFails));
  const slaUptimePct = num(stats.slaUptimePct, 100);
  const interruptionRate = clamp01(num(stats.interruptionRate, 0));
  const stake = Math.max(0, num(stats.stake, 0));
  const slashCount = Math.max(0, num(stats.slashCount, 0));

  const jobSuccess = bayesianRate(completed, completed + failed, { priorMean, priorWeight });
  const verification = bayesianRate(auditPasses, auditPasses + auditFails, { priorMean, priorWeight });
  const reliability = clamp01(slaUptimePct / 100) * (1 - interruptionRate);

  const quality =
    weights.jobSuccess * jobSuccess +
    weights.verification * verification +
    weights.reliability * reliability;

  // ステーク乗数: 無ステークでも minStakeFactor、stakeRef 以上で 1 に漸近（担保が信頼を増幅）
  const stakeFactor = minStakeFactor + (1 - minStakeFactor) * (1 - Math.exp(-stake / stakeRef));
  const slashPenalty = Math.min(1, slashCount * slashPenaltyPerEvent);
  const trustMultiplier = clamp01(stakeFactor * (1 - slashPenalty));

  const score = clamp01(quality * trustMultiplier);
  const tier =
    score >= 0.85 ? 'gold' : score >= 0.65 ? 'silver' : score >= 0.4 ? 'bronze' : 'probation';

  return {
    score,
    tier,
    components: { jobSuccess, verification, reliability, quality, stakeFactor, slashPenalty, trustMultiplier },
  };
}

/**
 * プロバイダ群をレピュテーション降順に並べる（マッチング/検索ランキング用）。
 * @param {Array<{id:string, stats:object}>} providers
 * @param {object} opts computeReputation に渡すオプション
 * @returns {Array<{id:string, score:number, tier:string}>}
 */
function rankProviders(providers, opts = {}) {
  if (!Array.isArray(providers)) throw new Error('providers must be an array');
  return providers
    .map((p) => {
      const { score, tier } = computeReputation(p && p.stats, opts);
      return { id: p && p.id, score, tier };
    })
    .sort((a, b) => b.score - a.score);
}

module.exports = { computeReputation, rankProviders, bayesianRate };
