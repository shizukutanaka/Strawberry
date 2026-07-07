// ファイルベースJSONストレージによる注文リポジトリ
const { createJsonRepository } = require('./createJsonRepository');

module.exports = createJsonRepository('orders.json', {
  finders: {
    getByUserId: { field: 'userId', many: true },
  },
});
