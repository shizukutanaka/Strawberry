// マスターアカウント3重認証API
const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const speakeasy = require('speakeasy');
const { verifyTOTP } = require('../utils/totp');
const { sendMail } = require('../utils/mailer');

const router = express.Router();

// --- Google OAuth2 設定 ---
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: '/master-auth/google/callback',
}, (accessToken, refreshToken, profile, done) => {
  // 許可されたGoogleアカウントのみ
  if (profile.emails[0].value === process.env.MASTER_GOOGLE_EMAIL) {
    return done(null, profile);
  } else {
    return done(null, false, { message: 'Not master account' });
  }
}));
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// --- セッション ---
router.use(session({
  secret: process.env.SESSION_SECRET || 'strawberry_master',
  resave: false,
  saveUninitialized: false
}));
router.use(passport.initialize());
router.use(passport.session());

// --- Google認証 ---
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', passport.authenticate('google', { failureRedirect: '/master-auth/fail' }), (req, res) => {
  req.session.googleAuth = true;
  res.redirect('/master-auth/totp');
});

// --- TOTP認証 ---
router.get('/totp', (req, res) => {
  if (!req.session.googleAuth) return res.status(401).send('Google認証未完了');
  res.send('<form method="POST"><input name="token" maxlength="6"><button>認証</button></form>');
});
router.post('/totp', (req, res) => {
  if (!req.session.googleAuth) return res.status(401).send('Google認証未完了');
  const valid = verifyTOTP(process.env.MASTER_TOTP_SECRET, req.body.token);
  if (valid) {
    req.session.totpAuth = true;
    // メール認証コード発行
    const mailCode = Math.floor(100000 + Math.random() * 900000).toString();
    req.session.mailCode = mailCode;
    sendMail(process.env.MASTER_GOOGLE_EMAIL, 'Strawberry マスター認証コード', `<b>認証コード: ${mailCode}</b>`);
    res.redirect('/master-auth/mail');
  } else {
    res.send('TOTP認証失敗');
  }
});

// --- メール認証 ---
router.get('/mail', (req, res) => {
  if (!req.session.totpAuth) return res.status(401).send('TOTP認証未完了');
  res.send('<form method="POST"><input name="code" maxlength="6"><button>認証</button></form>');
});
router.post('/mail', (req, res) => {
  if (!req.session.totpAuth) return res.status(401).send('TOTP認証未完了');
  if (req.body.code === req.session.mailCode) {
    req.session.masterAuth = true;
    res.send('マスター認証完了！');
  } else {
    res.send('メール認証失敗');
  }
});

// --- マスター認証ミドルウェア ---
function requireMasterAuth(req, res, next) {
  if (req.session && req.session.masterAuth) return next();
  res.status(403).send('マスター認証が必要です');
}

module.exports = { router, requireMasterAuth };
