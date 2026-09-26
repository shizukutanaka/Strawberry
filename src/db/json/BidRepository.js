// src/db/json/BidRepository.js
// オークション入札の永続化（docs/improvement-research-2026.md §17）。
// 談合・シール入札検出（src/marketplace/shill-detector.js）のための入札履歴を保持する。
// 行形式: { auctionId, providerId, pricePerHour, won, eligible, createdAt }。
const { createJsonRepository } = require('./createJsonRepository');

module.exports = createJsonRepository('bids.json', {
  finders: {
    getByAuctionId: { field: 'auctionId', many: true },
    getByProviderId: { field: 'providerId', many: true },
  },
});
