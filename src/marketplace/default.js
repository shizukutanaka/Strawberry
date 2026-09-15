// src/marketplace/default.js
// 既定の marketplace-service シングルトン。
// 現時点では quoteGpu（特徴量ベース価格見積り）のみを公開する。
// エスクロー/検証/レピュテーション連動サービスの配線は削除した
// （経緯: src/marketplace/marketplace-service.js 冒頭コメント参照）。
const { createMarketplaceService } = require('./marketplace-service');

module.exports = createMarketplaceService();
