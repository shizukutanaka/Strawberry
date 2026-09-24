// src/reputation/reputation-service.js
// レピュテーション・サービス（docs/SPECIFICATION.md F3）。
// ReputationRepository（永続化）と reputation-scorer（算出）を束ね、
// ジョブ成否・利用率監査・スラッシング・アテステーションのイベントを記録し、スコアを返す。
// order/index.js（完了・係争裁定の slash・利用率監査）と gpu/index.js（アテステーション）から呼ばれる。
// repository は DI 可能（既定 JSON、テストはインメモリ fake）。
const { computeReputation } = require('./reputation-scorer');

function defaultStats() {
  return {
    completedJobs: 0,
    failedJobs: 0,
    auditPasses: 0,
    auditFails: 0,
    slaUptimePct: 100,
    interruptionRate: 0,
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
      mutate(providerId, (s) => ({ slashCount: s.slashCount + Math.max(0, count) })),

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

    /** スコア＋tier を算出（未登録は既定 stats）。 */
    getScore: (providerId, opts = {}) => {
      const rec = repo.getByProviderId(providerId);
      const stats = rec ? { ...defaultStats(), ...rec.stats } : defaultStats();
      return computeReputation(stats, opts);
    },

    getStats: (providerId) => {
      const rec = repo.getByProviderId(providerId);
      return rec ? { ...defaultStats(), ...rec.stats } : defaultStats();
    },
  };
}

module.exports = { createReputationService, defaultStats };
