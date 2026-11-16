// src/marketplace/marketplace-service.js
// マーケットプレイス合成サービス（docs/SPECIFICATION.md §6-2 配線の中核）。
// 価格(feature-pricer)・レピュテーション・検証の各サービスを束ね、
// 高レベルのドメインフローに合成する。HTTP ルートハンドラはこのサービスを呼ぶ薄い
// ラッパとして実装すればよい（ルート直書きを避け、テスト可能性を確保）。
// 各サブサービスは DI（テストはインメモリ repo を注入）。
//
// 2026-11-16: 金銭機能（エスクロー・精算）の廃止に伴い、本サービスから
// escrowService への依存を除去した。検証（Proof-of-Compute）は貸し借りの
// 品質担保として残し、verifyAndSettle は検証専用の verifyJob へ置き換えた
// （旧実装は検証 verdict からエスクローの解放/係争イベントを導出していたが、
// 資金移動が無くなったため verdict はレピュテーション反映のみに使う）。
const featurePricer = require('../pricing/feature-pricer');
const { runAuction } = require('./auction-engine');

function createMarketplaceService({
  verificationService,
  reputationService,
  pricer = featurePricer,
  pricingOpts = {},
} = {}) {
  if (!verificationService || !reputationService) {
    throw new Error('verificationService, reputationService are required');
  }

  /** GPU 特徴量＋需給から時給を見積もる。 */
  function quoteGpu(gpu, market = {}) {
    return pricer.computePrice(gpu, market, pricingOpts);
  }

  /** 候補プロバイダをレピュテーション順に並べる（マッチング）。 */
  function rankCandidates(providerIds, opts = {}) {
    return reputationService.rank(providerIds, opts);
  }

  /**
   * 逆オークションでプロバイダを選定する（Akash/Golem 型マッチング）。
   * 各 bid のレピュテーションは reputationService から自動補完する（bid に
   * reputationScore があればそれを優先）。価格・レピュテーション・SLA・
   * アテステーションを統合した効用スコアで勝者を選ぶ。
   * @param {Array<object>} bids { providerId, pricePerHour, slaUptimePct?, attestationScore?, attestationPassed? }
   * @param {object} auctionOpts auction-engine の opts（reservePrice/minReputation/weights 等）
   * @returns {{winner, ranked, rejected}}
   */
  function selectProvider(bids, auctionOpts = {}) {
    if (!Array.isArray(bids)) throw new Error('bids must be an array');
    const enriched = bids.map((b) => {
      if (typeof b.reputationScore === 'number') return b;
      const rep = b.providerId ? reputationService.getScore(b.providerId) : { score: 0 };
      return { ...b, reputationScore: rep.score };
    });
    return runAuction(enriched, auctionOpts);
  }

  /**
   * ジョブ結果を検証し、verdict をプロバイダのレピュテーションへ反映する。
   * 検証自体の監査記録（recordAudit）は verificationService.finalize が担う。
   * ここではジョブ成否として recordJobResult を追加で記録する
   * （verified → 成功、failed → 失敗、inconclusive → 記録しない）。
   * @returns {{verdict, record}}
   */
  function verifyJob({ jobId, providerId = null, primaryOutput, utilSamples = [], replicas = [], auditRate }) {
    if (!jobId) throw new Error('jobId is required');
    verificationService.open(jobId, { providerId, auditRate });
    verificationService.recordPrimary(jobId, primaryOutput, { utilSamples });
    for (const r of replicas) verificationService.submitReplica(jobId, r);
    const v = verificationService.finalize(jobId);

    if (providerId) {
      if (v.verdict === 'verified') reputationService.recordJobResult(providerId, true);
      else if (v.verdict === 'failed') reputationService.recordJobResult(providerId, false);
    }
    return { verdict: v.verdict, record: v.record };
  }

  return { quoteGpu, rankCandidates, selectProvider, verifyJob };
}

module.exports = { createMarketplaceService };
