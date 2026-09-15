// tests/marketplace/marketplace-service.test.js
//
// hold-invoice エスクロー連動のテスト（open/pay/verify/resolve/settleByUsage）は
// 削除した。理由: escrow-service.js / verification-service.js ごと削除したため
// （2026-09 第8回点検: hold-invoice/HTLC エスクローはトラストレス機構であり、
// 運営を信頼させる custodial 設計の本製品には要件として噛み合わず、実注文でも
// 一度も使われていなかった。ARCHITECTURE.md「エスクロー機構の削除」節を参照）。
// 残るドメインフローは特徴量ベースの価格見積り（quoteGpu）のみ。
const { createMarketplaceService } = require('../../src/marketplace/marketplace-service');

const GPU = { vramGB: 80, memBandwidthGBs: 3350, benchmarkScore: 300, generation: 'hopper' };

describe('marketplace-service', () => {
  it('quotes a price with a confidence basis', () => {
    const mkt = createMarketplaceService();
    const q = mkt.quoteGpu(GPU, { utilization: 0.5 });
    expect(q.pricePerHour).toBeGreaterThan(0);
    expect(q.basis).toBeDefined();
    expect(typeof q.basis.confidence).toBe('string');
  });

  it('marks an unrecognized GPU as not quotable', () => {
    const mkt = createMarketplaceService();
    const q = mkt.quoteGpu({ vramGB: 8 }, {});
    expect(q.basis.confidence).toBe('unknown');
    expect(q.basis.quotable).toBe(false);
  });

  // selectProvider の検査は削除した（機能ごと削除したため）。ただしそこで見ていた
  // 「レピュテーションの高いプロバイダは、少し安いだけの低評価プロバイダに勝つ」という
  // 性質は借り手にとって重要なので、実在の出品を並べる GET /gpus?sort=recommended の
  // テストへ移してある（tests/api/gpu-recommended-sort.test.js）。
});
