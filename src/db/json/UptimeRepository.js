// src/db/json/UptimeRepository.js
// プロバイダー稼働実績のファイルベース JSON リポジトリ。
// 1 レコード = { id, providerId, beats, gapEvents, sessions, lastBeatAt, createdAt, updatedAt }
//  - beats: 受理したプロバイダー（lender ロール）ハートビートの累計
//  - gapEvents: 同一オーダー内でハートビート間隔が閾値を超えた回数（切断イベント相当）
//  - sessions: プロセス起動後に初回ハートビートを観測したオーダー数の累計
// 「providerId で一意」というアプリ層の制約は provider-uptime サービス側の upsert で担保する。
const { createJsonRepository } = require('./createJsonRepository');

module.exports = createJsonRepository('uptime.json', {
  finders: {
    getByProviderId: { field: 'providerId' },
  },
});
