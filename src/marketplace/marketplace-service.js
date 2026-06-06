// src/marketplace/marketplace-service.js
// マーケットプレイス合成サービス（docs/SPECIFICATION.md §6-2 配線の中核）。
// 価格(feature-pricer)・レピュテーション・検証・エスクローの各サービスを束ね、
// 高レベルのドメインフローに合成する。HTTP ルートハンドラはこのサービスを呼ぶ薄い
// ラッパとして実装すればよい（ルート直書きを避け、テスト可能性を確保）。
// 各サブサービスは DI（テストはインメモリ repo を注入）。
const featurePricer = require('../pricing/feature-pricer');

function createMarketplaceService({
  escrowService,
  verificationService,
  reputationService,
  pricer = featurePricer,
  pricingOpts = {},
} = {}) {
  if (!escrowService || !verificationService || !reputationService) {
    throw new Error('escrowService, verificationService, reputationService are required');
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
   * 注文に対し価格を確定し、hold-invoice エスクローを開く（PENDING）。
   * @returns {{escrow, quote, amountSats, providerId}}
   */
  function openOrderEscrow({ orderId, providerId = null, gpu = {}, durationMinutes = 0, market = {}, feeRate = 0 }) {
    if (!orderId) throw new Error('orderId required');
    const quote = quoteGpu(gpu, market);
    const hours = Math.max(0, durationMinutes) / 60;
    const amountSats = Math.round(quote.pricePerHour * hours);
    const escrow = escrowService.create({ orderId, amountSats, feeRate, invoice: null });
    return { escrow, quote, amountSats, providerId };
  }

  /** hold invoice 入金（PENDING→HELD）。 */
  function recordPaid(escrowId) {
    return escrowService.markPaid(escrowId);
  }

  /**
   * ジョブ結果を検証し、エスクローを解放/係争へ進め、レピュテーションを更新する。
   * @returns {{verdict, event, escrow, actions}}
   */
  function verifyAndSettle({ jobId, escrowId, providerId = null, primaryOutput, utilSamples = [], replicas = [], auditRate }) {
    if (!jobId || !escrowId) throw new Error('jobId and escrowId are required');
    verificationService.open(jobId, { providerId, escrowId, auditRate });
    verificationService.recordPrimary(jobId, primaryOutput, { utilSamples });
    for (const r of replicas) verificationService.submitReplica(jobId, r);
    const v = verificationService.finalize(jobId);

    const result = escrowService.evaluate(escrowId, v.verificationCtx);

    if (providerId) {
      if (result.event === 'DELIVER_OK') reputationService.recordJobResult(providerId, true);
      else if (result.event === 'DELIVER_FAIL') reputationService.recordJobResult(providerId, false);
    }
    return { verdict: v.verdict, event: result.event, escrow: result.escrow, actions: result.actions };
  }

  /** 係争の解決（'settle'/'refund'）。refund 時はプロバイダを slash。 */
  function resolveDispute(escrowId, decision, providerId = null) {
    const r = escrowService.resolveDispute(escrowId, decision);
    if (providerId && decision === 'refund') reputationService.slash(providerId);
    return r;
  }

  return { quoteGpu, rankCandidates, openOrderEscrow, recordPaid, verifyAndSettle, resolveDispute };
}

module.exports = { createMarketplaceService };
