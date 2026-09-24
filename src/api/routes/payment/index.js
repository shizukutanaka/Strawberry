// src/api/routes/payment/index.js - 支払い関連APIルート
// ハンドラ本体はドメイン別サブルータへ分割: invoices（発行/支払）・order-pay（注文支払）・
// reads（状態/ノード情報）・admin（手動審査）。invoices を reads より先に mount する
// （/invoice/:id が /:id/status に吸収されるのを防ぐ）。
const express = require('express');
const router = express.Router();

router.use(require('./invoices'));
router.use(require('./order-pay'));
router.use(require('./reads'));
router.use('/btc', require('./btc-onchain'));
router.use(require('./admin'));

module.exports = router;
