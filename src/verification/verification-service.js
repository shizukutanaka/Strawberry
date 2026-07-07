// src/verification/verification-service.js
// 検証サービス（docs/SPECIFICATION.md F2）。work-verifier（純関数）と VerificationRepository
// （永続化）を束ね、ジョブの監査要否決定・出力収集・consensus/ゼロ負荷判定で verdict を確定する。
// finalize は escrow-service.evaluate にそのまま渡せる verificationCtx を返し、
// 監査結果を reputationService へ反映する（いずれも DI、テストはインメモリ/省略可能）。
const { shouldAudit, outputsMatch, ternaryConsensus, detectZeroLoad } = require('./work-verifier');

function createVerificationService({
  repository,
  reputationService = null,
  auditRate = 0.1,
  tolerance = 1e-3,
  zeroLoad = {},
} = {}) {
  const repo = repository || require('../db/json/VerificationRepository');

  function mustGet(jobId) {
    const rec = repo.getByJobId(jobId);
    if (!rec) throw new Error(`verification record not found: ${jobId}`);
    return rec;
  }

  return {
    /** ジョブの検証レコードを開設し、監査要否(audited)を決定する。 */
    open(jobId, { providerId = null, escrowId = null, auditRate: ar } = {}) {
      if (!jobId) throw new Error('jobId required');
      const audited = shouldAudit(jobId, { auditRate: typeof ar === 'number' ? ar : auditRate });
      return repo.create({
        jobId,
        providerId,
        escrowId,
        audited,
        replicaOutputs: [],
        utilSamples: [],
        verdict: 'pending',
      });
    },

    /** 本実行プロバイダの出力と稼働中 GPU 利用率サンプルを記録。 */
    recordPrimary(jobId, output, { utilSamples = [] } = {}) {
      const rec = mustGet(jobId);
      return repo.update(rec.id, { primaryOutput: output, hasPrimary: true, utilSamples, updatedAt: new Date().toISOString() });
    },

    /** 監査用に別プロバイダの再実行結果を追加（ternary consensus 用）。 */
    submitReplica(jobId, output) {
      const rec = mustGet(jobId);
      return repo.update(rec.id, { replicaOutputs: [...(rec.replicaOutputs || []), output], updatedAt: new Date().toISOString() });
    },

    /**
     * verdict を確定する。
     * - ゼロ負荷の疑い → failed
     * - 非監査ジョブ → profiling のみで verified（再実行省略）
     * - 監査ジョブ: primary + replica≥2 → ternary consensus、replica=1 → 二者照合、replica=0 → inconclusive
     * @returns {{record, verdict, verificationCtx:{verified:boolean|null, suspectedZeroLoad:boolean}}}
     */
    finalize(jobId, opts = {}) {
      const rec = mustGet(jobId);
      const tol = typeof opts.tolerance === 'number' ? opts.tolerance : tolerance;

      let suspectedZeroLoad = false;
      if (Array.isArray(rec.utilSamples) && rec.utilSamples.length > 0) {
        suspectedZeroLoad = detectZeroLoad(rec.utilSamples, zeroLoad).suspectedZeroLoad;
      }

      const replicas = rec.replicaOutputs || [];
      let verdict = 'inconclusive';
      let verified = null;
      let consensus = null;

      if (suspectedZeroLoad) {
        verdict = 'failed';
        verified = false;
      } else if (!rec.audited) {
        verdict = 'verified';
        verified = true;
      } else if (rec.hasPrimary && replicas.length >= 2) {
        consensus = ternaryConsensus([rec.primaryOutput, ...replicas], { tolerance: tol });
        verified = consensus.agreed && outputsMatch(consensus.value, rec.primaryOutput, { tolerance: tol });
        verdict = verified ? 'verified' : 'failed';
      } else if (rec.hasPrimary && replicas.length === 1) {
        verified = outputsMatch(rec.primaryOutput, replicas[0], { tolerance: tol });
        verdict = verified ? 'verified' : 'failed';
      } else {
        verdict = 'inconclusive';
        verified = null;
      }

      const saved = repo.update(rec.id, {
        verdict,
        consensus,
        suspectedZeroLoad,
        verified,
        updatedAt: new Date().toISOString(),
      });

      if (reputationService && rec.providerId && (verdict === 'verified' || verdict === 'failed')) {
        reputationService.recordAudit(rec.providerId, verdict === 'verified');
      }

      return {
        record: saved,
        verdict,
        // escrow-service.evaluate にそのまま渡せる（inconclusive は null=WAIT）
        verificationCtx: { verified, suspectedZeroLoad },
      };
    },

    get: (jobId) => repo.getByJobId(jobId),
  };
}

module.exports = { createVerificationService };
