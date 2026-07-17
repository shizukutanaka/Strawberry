// ファイルベースJSONストレージによるGPUリポジトリ
const { createJsonRepository } = require('./createJsonRepository');

module.exports = createJsonRepository('gpus.json', {
  finders: {
    getByOwner: { field: 'ownerId', many: true },
  },
});
