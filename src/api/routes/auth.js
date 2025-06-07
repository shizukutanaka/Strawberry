// auth.js - OAuth認証ルート（Google, GitHub, RESTful Google）
const express = require('express');
const router = express.Router();
const passport = require('../middleware/oauth');

// Google OAuth (Webフロー)
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/login', session: false }),
  (req, res) => {
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
    res.json({
      message: 'GitHub認証成功',
      user: req.user
    });
  }
);

// Google OAuth2 RESTful認証（POST /api/auth/google）
router.use('/google', require('./auth/google'));

module.exports = router;
