// src/api/routes/gpu/index.js - GPU関連APIルート
// ハンドラ本体はドメイン別サブルータへ分割: reads（GET群）・lifecycle（登録/更新/削除）・
// blocks（メンテナンスブロック）・watch（価格ウォッチ）。
const express = require('express');
const router = express.Router();

const reads = require('./reads');
router.use(reads);
router.use(require('./lifecycle'));
router.use(require('./blocks'));
router.use(require('./watch'));

module.exports = router;
// order 側（disputes.js）がレビュー時にキャッシュを無効化するための公開面
module.exports._invalidateGpuRatingCache = reads._invalidateGpuRatingCache;
