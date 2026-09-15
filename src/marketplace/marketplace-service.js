// src/marketplace/marketplace-service.js
// マーケットプレイス合成サービス（docs/SPECIFICATION.md §6-2 配線の中核）。
// 現時点で残っている唯一のドメインフローは特徴量ベースの価格見積り（quoteGpu）。
// hold-invoice エスクロー・検証・レピュテーション連動の合成フロー
// （openOrderEscrow/recordPaid/verifyAndSettle/resolveDispute/settleByUsage/getEscrow）は
// 削除した。理由: hold-invoice/HTLC エスクローは「運営を信頼しなくても資金が守られる」
// ためのトラストレス機構だが、この製品は運営のLightningノードへ入金し運営が
// payout-ledger.js で後払いする custodial 設計を一貫して採っている（README.md /
// ARCHITECTURE.md 参照）。トラストレス機構をcustodial設計に足しても要件として
// 成立せず、実注文でも一度も使われていなかった（実処理は payout-ledger.js の
// computeSettlement() 経路のみ）。詳細は ARCHITECTURE.md「エスクロー機構の削除」節。
const featurePricer = require('../pricing/feature-pricer');
const { toPricingFeatures, computePerfScore } = require('../gpu/perf-score');

function createMarketplaceService({
  pricer = featurePricer,
  pricingOpts = {},
} = {}) {
  /**
   * GPU 特徴量＋需給から時給を見積もる。
   * 入力は出品レコード（memoryGB / performance.teraflops）でも feature-pricer 語彙
   * （vramGB / memBandwidthGBs / benchmarkScore）でも良い。前者は toPricingFeatures で
   * 変換する — 変換前は実レコードの特徴量が全て 0 と評価され、見積が価格フロアに
   * 張り付いていた。
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
  // selectProvider（逆オークション）は削除した。唯一の呼び出し口だった
  // POST /marketplace/auction が入札内容を呼び出し側から受け取っており、
  // この製品には入札を保存する場所も貸し手が要件を見る画面も無いため、
  // 「実装済み」に見えて何も意味しない機能だった。効用スコアの計算だけは
  // GET /gpus?sort=recommended が実データに対して使っている。

  return { quoteGpu };
}

module.exports = { createMarketplaceService };
