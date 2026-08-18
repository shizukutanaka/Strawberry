// src/db/json/LedgerRepository.js
// 収益台帳（provider の稼ぎ / renter への返金 / 出金）の追記型リポジトリ。
// 1 行 = 1 仕訳。残高は行の合計で導出し、残高そのものは保存しない
// （保存された残高と仕訳が食い違うと、どちらが正しいか誰にも分からなくなる）。
const { createJsonRepository } = require('./createJsonRepository');

module.exports = createJsonRepository('ledger.json', {
  finders: {
    getByUserId: { field: 'userId', many: true },
    getByOrderId: { field: 'orderId', many: true },
  },
});
