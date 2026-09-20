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
  pricer = featurePricer,
  pricingOpts = {},
} = {}) {
  if (!escrowService || !verificationService) {
    throw new Error('escrowService and verificationService are required');
  }

  /**
   * 注文に対し価格を確定し、hold-invoice エスクローを開く（PENDING）。
   * @returns {{escrow, quote, amountSats, providerId}}
   */
  function openOrderEscrow({ orderId, providerId = null, gpu = {}, durationMinutes = 0, market = {}, feeRate = 0, amountSatOverride }) {
    if (!orderId) throw new Error('orderId required');
    const quote = pricer.computePrice(gpu, market, pricingOpts);
    const hours = Math.max(0, durationMinutes) / 60;
    // amountSatOverride: HTTP ルートが注文の price-locked totalPrice を渡す。
    // 渡されない場合（ユニットテスト・直接呼び出し）は quote から計算する。
    const amountSats = typeof amountSatOverride === 'number' ? amountSatOverride : Math.round(quote.pricePerHour * hours);
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

    return { verdict: v.verdict, event: result.event, escrow: result.escrow, actions: result.actions };
  }

  /** 係争の解決（'settle'/'refund'）。refund 時はプロバイダを slash。 */
  function resolveDispute(escrowId, decision, providerId = null) {
    return escrowService.resolveDispute(escrowId, decision);
  }

  /**
   * 実使用量・SLA に応じた従量按分の精算内訳を計算・記録する。
   * heartbeat で計測した accumulatedSeconds と予約時間から deliveredRatio を求めて渡す。
   * @returns {{escrow, settlement}}
   */
  function settleByUsage(escrowId, usage = {}, opts = {}) {
    return escrowService.settle(escrowId, usage, opts);
  }

  /** エスクローの現在状態を取得（読み取り）。 */
  function getEscrow(escrowId) {
    return escrowService.get(escrowId);
  }

  return { openOrderEscrow, recordPaid, verifyAndSettle, settleByUsage, resolveDispute, getEscrow };
}

module.exports = { createMarketplaceService };
