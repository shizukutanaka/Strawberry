// ファイルベースJSONストレージによるGPUリポジトリ
const { createJsonRepository } = require('./createJsonRepository');

module.exports = createJsonRepository('gpus.json');
