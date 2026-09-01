// src/marketplace/marketplace-service.js
// マーケットプレイス合成サービス（docs/SPECIFICATION.md §6-2 配線の中核）。
// 価格(feature-pricer)・レピュテーション・検証・エスクローの各サービスを束ね、
// 高レベルのドメインフローに合成する。HTTP ルートハンドラはこのサービスを呼ぶ薄い
// ラッパとして実装すればよい（ルート直書きを避け、テスト可能性を確保）。
// 各サブサービスは DI（テストはインメモリ repo を注入）。
const featurePricer = require('../pricing/feature-pricer');
const { toPricingFeatures, computePerfScore } = require('../gpu/perf-score');

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

  /**
   * GPU 特徴量＋需給から時給を見積もる。
   * 入力は出品レコード（memoryGB / performance.teraflops）でも feature-pricer 語彙
   * （vramGB / memBandwidthGBs / benchmarkScore）でも良い。前者は toPricingFeatures で
   * 変換する — 変換前は実レコードの特徴量が全て 0 と評価され、見積が価格フロアに
   * 張り付いていた（openOrderEscrow から実 GPU レコードが渡る経路）。
   */
  function quoteGpu(gpu, market = {}) {
    const price = pricer.computePrice(toPricingFeatures(gpu), market, pricingOpts);
    // **根拠の有無を必ず添える。** feature-pricer は特徴量が全部欠けていても
    // 数字を返す（VRAM だけの未知型番でも 333 sats/時 のような値が出る）。
    // それを「参考価格」として人に見せるのは、この製品が避けてきた
    // 「知らないのに知っているふりをする」やり方にあたる。
    // perf-score は同じ問題に対して既に答えを持っている——参照表に当たらない、
    // または演算性能の根拠が無い型番は score=null / confidence='unknown' を返す。
    // その判定をそのまま価格側にも通す。
    const perf = computePerfScore(gpu);
    return {
      ...price,
      basis: {
        confidence: perf.confidence,          // reference / attested / declared / unknown
        matchedModel: perf.matchedModel,      // 参照表で当たった型番（当たらなければ null）
        // 提示してよいか。unknown は「VRAM だけで値段を作った」状態なので出さない。
        quotable: perf.confidence !== 'unknown',
        findings: perf.findings,
      },
    };
  }

  /** 候補プロバイダをレピュテーション順に並べる（マッチング）。 */
  function rankCandidates(providerIds, opts = {}) {
    return reputationService.rank(providerIds, opts);
  }

  // selectProvider（逆オークション）は削除した。唯一の呼び出し口だった
  // POST /marketplace/auction が入札内容を呼び出し側から受け取っており、
  // この製品には入札を保存する場所も貸し手が要件を見る画面も無いため、
  // 「実装済み」に見えて何も意味しない機能だった。効用スコアの計算だけは
  // GET /gpus?sort=recommended が実データに対して使っている。

  /**
   * 注文に対し価格を確定し、hold-invoice エスクローを開く（PENDING）。
   * @returns {{escrow, quote, amountSats, providerId}}
   */
  function openOrderEscrow({ orderId, providerId = null, gpu = {}, durationMinutes = 0, market = {}, feeRate = 0, amountSatOverride }) {
    if (!orderId) throw new Error('orderId required');
    const quote = quoteGpu(gpu, market);
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

  return { quoteGpu, rankCandidates, openOrderEscrow, recordPaid, verifyAndSettle, settleByUsage, resolveDispute, getEscrow };
}

module.exports = { createMarketplaceService };
