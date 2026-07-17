// src/db/json/VerificationRepository.js
// 検証レコード永続化（docs/SPECIFICATION.md: Verification record エンティティ）。jobId 単位。
const { createJsonRepository } = require('./createJsonRepository');

module.exports = createJsonRepository('verifications.json', {
  finders: {
    getByJobId: { field: 'jobId' },
  },
});
