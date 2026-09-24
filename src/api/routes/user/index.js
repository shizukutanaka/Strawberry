// src/api/routes/user/index.js - ユーザー関連APIルート
// ハンドラ本体はドメイン別サブルータへ分割: auth（認証）・me（セルフサービス）・
// admin（管理者操作）。me を admin より先に mount する（/me が /:id に吸収されるのを防ぐ）。
const express = require('express');
const router = express.Router();

router.use(require('./auth'));
router.use(require('./me'));
router.use(require('./admin'));

module.exports = router;
