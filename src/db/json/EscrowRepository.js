// src/db/json/EscrowRepository.js
// ファイルベースJSONストレージによるエスクロー・リポジトリ（docs/SPECIFICATION.md: Escrow エンティティ）。
const { createJsonRepository } = require('./createJsonRepository');

module.exports = createJsonRepository('escrows.json', {
  finders: {
    getByOrderId: { field: 'orderId', many: true },
  },
});
