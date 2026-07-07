// ファイルベースJSONストレージによる決済リポジトリ
const { createJsonRepository } = require('./createJsonRepository');

module.exports = createJsonRepository('payments.json', {
  finders: {
    getByOrderId: { field: 'orderId', many: true },
    getByUserId: { field: 'userId', many: true },
    getByPaymentHash: { field: 'paymentHash', many: true },
  },
});
