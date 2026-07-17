// src/db/json/ReputationRepository.js
// プロバイダ・レピュテーション永続化（docs/SPECIFICATION.md: Provider reputation エンティティ）。
// providerId をキーに1レコード。
const { createJsonRepository } = require('./createJsonRepository');

module.exports = createJsonRepository('reputations.json', {
  finders: {
    getByProviderId: { field: 'providerId' },
  },
});
