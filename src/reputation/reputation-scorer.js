// src/reputation/reputation-scorer.js
// ホスト(プロバイダ)レピュテーション・スコアラ（docs/category-research-2026.md カテゴリ5）。
// SLA・ジョブ成否・利用率監査・スラッシングから [0,1] の信頼度スコアを算出する純関数。
// GPU 詳細の「出品者の信頼度」と GET /gpus?sort=recommended が使う。インフラ非依存・テスト可能。
//
// 担保ステーク（stake）の項は削除した（2026-09 第9回点検）。ステークを預ける経路が製品に
// 存在せず全員 stake=0 だったため、乗数が常に minStakeFactor=0.5 に固定され、**全スコアが
// 一律に半分に抑えられていた**。tier の閾値（silver 0.65 / gold 0.85）には誰も届かず、UI の
// 「評判」は bronze か probation しか表示し得なかった。担保ステークは運営を信頼しなくてよい
// ためのトラストレス機構で、運営が資金を預かる custodial 設計の本製品では成立しない
// （エスクロー削除と同じ判断。ARCHITECTURE.md「エスクロー機構の削除」節）。

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
  // priorWeight は厳密に正にクランプ（呼び出し側が 0/負を渡すと分母 0 → NaN になり
  // ランキングソートを破壊する。opts はマーケット API 経由でユーザー制御可能なため必須）。
  const pw = Math.max(1e-9, num(priorWeight, 5));
  const pm = clamp01(num(priorMean, 0.8));
  return (s + pm * pw) / (t + pw);
}

/**
 * ホストのレピュテーションを算出する。
 * @param {object} stats
 *   completedJobs, failedJobs        … 完了/失敗ジョブ数
 *   auditPasses, auditFails          … 再実行監査の合否（work-verifier 連携）
 *   slaUptimePct                     … 稼働率(%) 既定100
 *   interruptionRate                 … 中断率 [0,1] 既定0
 *   slashCount                       … スラッシング回数 既定0
 * @param {object} opts weights/slashPenaltyPerEvent/priorMean/priorWeight
 * @returns {{score:number, tier:string, components:object}}
 */
function computeReputation(stats = {}, opts = {}) {
  const {
    weights: rawWeights = { jobSuccess: 0.4, verification: 0.4, reliability: 0.2 },
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
  const slashCount = Math.max(0, num(stats.slashCount, 0));

  const jobSuccess = bayesianRate(completed, completed + failed, { priorMean, priorWeight });
  const verification = bayesianRate(auditPasses, auditPasses + auditFails, { priorMean, priorWeight });
  const reliability = clamp01(slaUptimePct / 100) * (1 - interruptionRate);

  const quality =
    weights.jobSuccess * jobSuccess +
    weights.verification * verification +
    weights.reliability * reliability;

  const slashPenalty = Math.min(1, slashCount * slashPenaltyPerEvent);
  const trustMultiplier = clamp01(1 - slashPenalty);

  const score = clamp01(quality * trustMultiplier);
  const tier =
    score >= 0.85 ? 'gold' : score >= 0.65 ? 'silver' : score >= 0.4 ? 'bronze' : 'probation';

  return {
    score,
    tier,
    components: { jobSuccess, verification, reliability, quality, slashPenalty, trustMultiplier },
  };
}

module.exports = { computeReputation, bayesianRate };
