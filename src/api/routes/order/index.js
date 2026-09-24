// src/api/routes/order/index.js - 注文APIルート
// ハンドラ本体はドメイン別サブルータへ分割: reads（読み取り）・runtime（ハートビート/
// 起動停止）・mutations（作成/更新/削除/マッチング）・disputes（紛争/レビュー）。
const express = require('express');
const router = express.Router();

const {
  usageSessions,
  OrderUsageSession,
  reapUsageSessions,
  sweepHeartbeatSlaBreaches,
} = require('./sessions');
const mutations = require('./mutations');

router.use(require('./reads'));
router.use(require('./runtime'));
router.use(mutations);
router.use(require('./disputes'));

module.exports = router;
module.exports._usageSessions = usageSessions;
module.exports._reapUsageSessions = reapUsageSessions;
module.exports._sweepHeartbeatSlaBreaches = sweepHeartbeatSlaBreaches;
module.exports._OrderUsageSession = OrderUsageSession;
module.exports._checkOrderCreateRateLimit = mutations._checkOrderCreateRateLimit;
