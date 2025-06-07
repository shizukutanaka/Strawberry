// src/api/routes/auth/index.js - 認証ルート統括
const express = require('express');
const router = express.Router();

router.use('/google', require('./google'));

module.exports = router;
