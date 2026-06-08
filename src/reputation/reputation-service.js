// src/reputation/reputation-service.js
// レピュテーション・サービス（docs/SPECIFICATION.md F3）。
// ReputationRepository（永続化）と reputation-scorer（算出）を束ね、
// ジョブ成否・検証監査・スラッシング・ステーク・SLA のイベントを記録し、スコアを返す。
// escrow-service の slash_provider / work-verifier の監査結果から呼ばれる想定。
// repository は DI 可能（既定 JSON、テストはインメモリ fake）。
const { computeReputation, rankProviders } = require('./reputation-scorer');

function defaultStats() {
  return {
    completedJobs: 0,
    failedJobs: 0,
    auditPasses: 0,
    auditFails: 0,
    slaUptimePct: 100,
    interruptionRate: 0,
    stake: 0,
    slashCount: 0,
  };
}

function createReputationService({ repository } = {}) {
  const repo = repository || require('../db/json/ReputationRepository');

  function ensure(providerId) {
    if (!providerId) throw new Error('providerId required');
    const rec = repo.getByProviderId(providerId);
    if (rec) return rec;
    return repo.create({ providerId, stats: defaultStats() });
  }

  // 現在の stats に patch(stats)->部分stats を適用して保存
  function mutate(providerId, patchFn) {
    const rec = ensure(providerId);
    const stats = { ...defaultStats(), ...rec.stats };
    const next = { ...stats, ...patchFn(stats) };
    return repo.update(rec.id, { stats: next, updatedAt: new Date().toISOString() });
  }

  return {
    /** ジョブ完了/失敗を記録。 */
    recordJobResult: (providerId, ok) =>
      mutate(providerId, (s) => (ok ? { completedJobs: s.completedJobs + 1 } : { failedJobs: s.failedJobs + 1 })),

    /** 再実行監査の合否を記録（work-verifier 連携）。 */
    recordAudit: (providerId, pass) =>
      mutate(providerId, (s) => (pass ? { auditPasses: s.auditPasses + 1 } : { auditFails: s.auditFails + 1 })),

    /** スラッシング（検証不一致/SLA違反/紛争 refund 時）。 */
    slash: (providerId, count = 1) =>
      mutate(providerId, (s) => ({ slashCount: s.slashCount + Math.max(1, count) })),

    /** 担保ステークの増減/設定。 */
    addStake: (providerId, amount) =>
      mutate(providerId, (s) => ({ stake: Math.max(0, s.stake + amount) })),
    setStake: (providerId, amount) =>
      mutate(providerId, () => ({ stake: Math.max(0, amount) })),

    /**
     * GPU アテステーション合否を記録。
     * 失敗時はスラッシュも加算（申告詐称は最重大のペナルティ）。
     */
    recordAttestation: (providerId, passed) =>
      mutate(providerId, (s) =>
        passed
          ? { attestationPasses: (s.attestationPasses || 0) + 1 }
          : {
              attestationFails: (s.attestationFails || 0) + 1,
              slashCount: s.slashCount + 1,
            },
      ),

    /** SLA 指標の更新。 */
    setSla: (providerId, { slaUptimePct, interruptionRate } = {}) =>
      mutate(providerId, (s) => ({
        slaUptimePct: typeof slaUptimePct === 'number' ? slaUptimePct : s.slaUptimePct,
        interruptionRate: typeof interruptionRate === 'number' ? interruptionRate : s.interruptionRate,
      })),

    /** スコア＋tier を算出（未登録は既定 stats）。 */
    getScore: (providerId, opts = {}) => {
      const rec = repo.getByProviderId(providerId);
      const stats = rec ? { ...defaultStats(), ...rec.stats } : defaultStats();
      return computeReputation(stats, opts);
    },

    /** プロバイダ群をスコア降順に並べる（マッチング/検索ランキング）。 */
    rank: (providerIds, opts = {}) => {
      if (!Array.isArray(providerIds)) throw new Error('providerIds must be an array');
      const providers = providerIds.map((providerId) => {
        const rec = repo.getByProviderId(providerId);
        return { id: providerId, stats: rec ? { ...defaultStats(), ...rec.stats } : defaultStats() };
      });
      return rankProviders(providers, opts);
    },

    getStats: (providerId) => {
      const rec = repo.getByProviderId(providerId);
      return rec ? { ...defaultStats(), ...rec.stats } : defaultStats();
    },
  };
}

module.exports = { createReputationService, defaultStats };
