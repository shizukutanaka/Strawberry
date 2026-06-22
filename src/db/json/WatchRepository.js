// src/db/json/WatchRepository.js
// GPU 価格ウォッチ（値下げアラート）のファイルベース JSON リポジトリ。
// 1 レコード = { id, userId, gpuId, targetPrice, lastNotifiedPrice, lastNotifiedAt, createdAt }
// 「(userId, gpuId) で一意」というアプリ層の制約はルート側で upsert により担保する。
const { createJsonRepository } = require('./createJsonRepository');

module.exports = createJsonRepository('watches.json', {
  finders: {
    getByUser: { field: 'userId', many: true },
    getByGpu: { field: 'gpuId', many: true },
  },
});
