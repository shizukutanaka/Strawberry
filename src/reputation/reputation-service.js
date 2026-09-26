// src/reputation/reputation-service.js
// レピュテーション・サービス（docs/SPECIFICATION.md F3）。
// ReputationRepository（永続化）と reputation-scorer（算出）を束ね、
// ジョブ成否・検証監査・スラッシング・ステーク・SLA のイベントを記録し、スコアを返す。
// escrow-service の slash_provider / work-verifier の監査結果から呼ばれる想定。
// repository は DI 可能（既定 JSON、テストはインメモリ fake）。
const { computeReputation, rankProviders } = require('./reputation-scorer');
const crypto = require('crypto');

// ステーク出金のアンボンディング期間（既定 72h、EigenLayer/Cosmos 型）。
// 出金申請から支払可能までの猶予中も担保はスラッシュ対象のまま残り、
// 「違反 → スラッシュ前に担保を引き出す」 hit-and-run を防ぐ。
const DEFAULT_STAKE_UNBOND_MS = 72 * 3600 * 1000;
const stakeUnbondMs = () => Number(process.env.STAKE_UNBOND_MS || DEFAULT_STAKE_UNBOND_MS);

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
      mutate(providerId, (s) => ({ slashCount: s.slashCount + Math.max(0, count) })),

    /** 担保ステークの増減/設定。 */
    addStake: (providerId, amount) =>
      mutate(providerId, (s) => ({ stake: Math.max(0, s.stake + amount) })),
    setStake: (providerId, amount) =>
      mutate(providerId, () => ({ stake: Math.max(0, amount) })),

    /**
     * ステーク出金申請（アンボンディング）。
     * 申請時点では stake を減らさず pendingWithdrawals に記録するだけ — 猶予期間中も
     * 担保はスラッシュ可能なまま残る。claim 時に初めて控除される。
     * @returns {{ok:boolean, reason?:string, withdrawal?:object}}
     */
    requestStakeWithdrawal: (providerId, amountSats, opts = {}) => {
      const amount = Math.floor(Number(amountSats));
      if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'invalid_amount' };
      const unbondMs = Number.isFinite(opts.unbondMs) ? opts.unbondMs : stakeUnbondMs();
      const now = opts.now || Date.now();
      let result = null;
      mutate(providerId, (s) => {
        const pending = Array.isArray(s.pendingWithdrawals) ? s.pendingWithdrawals : [];
        const pendingTotal = pending.reduce((t, w) => t + (w.amountSats || 0), 0);
        // stake は申請時に減らないため、既存 pending も合わせた総額が stake 以下であることを要求
        if (amount + pendingTotal > s.stake) { result = { ok: false, reason: 'insufficient_stake', stake: s.stake, pendingTotal }; return {}; }
        const withdrawal = {
          id: `wd_${crypto.randomBytes(8).toString('hex')}`,
          amountSats: amount,
          requestedAt: new Date(now).toISOString(),
          eligibleAt: new Date(now + unbondMs).toISOString(),
        };
        result = { ok: true, withdrawal };
        return { pendingWithdrawals: [...pending, withdrawal] };
      });
      return result;
    },

    /**
     * 出金申請の受取（unbond 期間経過分のみ）。eligible 分を stake から控除して返す。
     * 猶予期間中のスラッシュで stake が目減りしていれば、受取額は残存 stake までに丸まる。
     */
    claimStakeWithdrawals: (providerId, opts = {}) => {
      const now = opts.now || Date.now();
      let result = null;
      mutate(providerId, (s) => {
        const pending = Array.isArray(s.pendingWithdrawals) ? s.pendingWithdrawals : [];
        const eligible = pending.filter((w) => new Date(w.eligibleAt).getTime() <= now);
        const remaining = pending.filter((w) => new Date(w.eligibleAt).getTime() > now);
        const requested = eligible.reduce((t, w) => t + (w.amountSats || 0), 0);
        const released = Math.min(requested, s.stake); // スラッシュ済み分は出金不可
        result = {
          ok: true, releasedSats: released, requestedSats: requested,
          claimed: eligible, pendingWithdrawals: remaining, stake: s.stake - released,
        };
        return { pendingWithdrawals: remaining, stake: s.stake - released };
      });
      return result;
    },

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
