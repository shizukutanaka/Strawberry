// auth.js - OAuth認証ルート（Google, GitHub）
const express = require('express');
const router = express.Router();
const passport = require('../middleware/oauth');

// Google OAuth
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/login', session: false }),
  (req, res) => {
    // JWT発行・ユーザーDB登録等はここで拡張可能
    res.json({
      message: 'Google認証成功',
      user: req.user
    });
  }
);

// GitHub OAuth
router.get('/github', passport.authenticate('github', { scope: ['user:email'] }));
router.get('/github/callback',
  passport.authenticate('github', { failureRedirect: '/login', session: false }),
  (req, res) => {
    // JWT発行・ユーザーDB登録等はここで拡張可能
    res.json({
      message: 'GitHub認証成功',
      user: req.user
    });
  }
);

module.exports = router;
