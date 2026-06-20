// マスターアカウント3重認証API
const express = require('express');
const crypto = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const speakeasy = require('speakeasy');
const { verifyTOTP } = require('../utils/totp');
const { sendMail } = require('../utils/mailer');
const { requireSecret } = require('../../utils/config');

const router = express.Router();

// メール認証コードの有効期限（10分）
const MAIL_CODE_TTL_MS = 10 * 60 * 1000;

// TOTP ブルートフォース対策: セッションスコープのカウンタは新セッション開始で
// リセットできる（バイパス可能）。プロセスレベルの IP ベースカウンタで補完する。
// 15分ウィンドウで最大10回。セッション側（5回）と合わせて2重防御。
const _totpIpMap = new Map(); // IP -> { count, windowStart }
const TOTP_IP_WINDOW_MS = 15 * 60 * 1000;
const TOTP_IP_MAX = 10;

function _checkTotpIpLimit(ip) {
  const now = Date.now();
  const rec = _totpIpMap.get(ip);
  if (!rec || now - rec.windowStart > TOTP_IP_WINDOW_MS) {
    _totpIpMap.set(ip, { count: 1, windowStart: now });
    return false; // not rate-limited
  }
  rec.count += 1;
  if (rec.count > TOTP_IP_MAX) return true; // rate-limited
  return false;
}

// タイミング攻撃耐性のある文字列比較（長さが違えば false、同長なら定時間比較）
function timingSafeStrEqual(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// --- Google OAuth2 設定 ---
// GOOGLE_CLIENT_ID 未設定だと GoogleStrategy のコンストラクタが throw して
// 起動できないため、env が揃っている場合のみ登録する。
const googleOAuthEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
if (googleOAuthEnabled) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/master-auth/google/callback',
    // OAuth2 state パラメータをセッションに保持し、callback で照合する。
    // これが無いと攻撃者が prep したフローに operator を巻き込む login-CSRF が成立する。
    state: true,
  }, (accessToken, refreshToken, profile, done) => {
    // 許可されたGoogleアカウントのみ。email_verified もチェックする:
    // 未確認メールアドレスを持つアカウントが同じメールアドレス文字列を持てる。
    const emailEntry = profile.emails && profile.emails[0];
    if (emailEntry && emailEntry.value === process.env.MASTER_GOOGLE_EMAIL && emailEntry.verified === true) {
      return done(null, profile);
    } else {
      return done(null, false, { message: 'Not master account or email not verified' });
    }
  }));
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((obj, done) => done(null, obj));
}

// --- セッション ---
router.use(session({
  secret: requireSecret('SESSION_SECRET'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  }
}));
router.use(passport.initialize());
router.use(passport.session());

// --- Google認証 ---
const ensureGoogleEnabled = (req, res, next) => {
  if (!googleOAuthEnabled) {
    return res.status(503).send('Google OAuth is not configured (set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)');
  }
  next();
};
router.get('/google', ensureGoogleEnabled, (req, res, next) => passport.authenticate('google', { scope: ['profile', 'email'], state: true })(req, res, next));
router.get('/google/callback', ensureGoogleEnabled, (req, res, next) => passport.authenticate('google', { failureRedirect: '/master-auth/fail', state: true })(req, res, next), (req, res) => {
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('セッション初期化エラー');
    req.session.googleAuth = true;
    res.redirect('/master-auth/totp');
  });
});

// --- TOTP認証 ---
router.get('/totp', (req, res) => {
  if (!req.session.googleAuth) return res.status(401).send('Google認証未完了');
  res.send('<form method="POST"><input name="token" maxlength="6"><button>認証</button></form>');
});
router.post('/totp', async (req, res) => {
  if (!req.session.googleAuth) return res.status(401).send('Google認証未完了');
  const { token } = req.body;
  if (!token || typeof token !== 'string' || !/^\d{6}$/.test(token)) {
    return res.status(400).send('認証コードは6桁の数字を入力してください');
  }
  // 2重防御: セッションスコープ（5回）＋ IP スコープ（15分10回）。
  // セッションスコープだけだと新セッション開始でリセットできるため IP ベースで補完。
  const clientIp = req.socket.remoteAddress || req.ip || 'unknown';
  if (_checkTotpIpLimit(clientIp)) {
    return res.status(429).send('試行回数が多すぎます（IP制限）。しばらく待ってください。');
  }
  req.session.totpAttempts = (req.session.totpAttempts || 0) + 1;
  if (req.session.totpAttempts > 5) {
    return res.status(429).send('試行回数が多すぎます。Google認証からやり直してください。');
  }
  const valid = verifyTOTP(process.env.MASTER_TOTP_SECRET, token);
  if (!valid) {
    return res.status(401).send('TOTP認証失敗');
  }
  req.session.totpAttempts = 0;
  req.session.totpAuth = true;
  // メール認証コード発行（暗号論的乱数。Math.random は予測可能で不可）
  const mailCode = crypto.randomInt(100000, 1000000).toString();
  req.session.mailCode = mailCode;
  req.session.mailCodeExpires = Date.now() + MAIL_CODE_TTL_MS;
  // 送信失敗を握りつぶさない（await＋例外処理）。失敗時はコードを無効化して再試行を促す。
  try {
    await sendMail(process.env.MASTER_GOOGLE_EMAIL, 'Strawberry マスター認証コード', `<b>認証コード: ${mailCode}</b>`);
  } catch (e) {
    req.session.mailCode = null;
    req.session.mailCodeExpires = null;
    return res.status(502).send('認証コードの送信に失敗しました。再試行してください。');
  }
  res.redirect('/master-auth/mail');
});

// --- メール認証 ---
router.get('/mail', (req, res) => {
  if (!req.session.totpAuth) return res.status(401).send('TOTP認証未完了');
  res.send('<form method="POST"><input name="code" maxlength="6"><button>認証</button></form>');
});
router.post('/mail', (req, res) => {
  if (!req.session.totpAuth) return res.status(401).send('TOTP認証未完了');
  // コード再送などでリトライ攻撃を繰り返す場合の深層防御カウンター。
  // コードは単回限り消去されるが、セッションレベルで試行数も上限を設ける。
  req.session.mailAttempts = (req.session.mailAttempts || 0) + 1;
  if (req.session.mailAttempts > 5) {
    return res.status(429).send('試行回数が多すぎます。Google認証からやり直してください。');
  }
  const { code } = req.body;
  if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return res.status(400).send('認証コードは6桁の数字を入力してください');
  }
  // 期限切れ/未発行を拒否
  if (!req.session.mailCode || !req.session.mailCodeExpires || Date.now() > req.session.mailCodeExpires) {
    req.session.mailCode = null;
    req.session.mailCodeExpires = null;
    return res.status(401).send('認証コードの有効期限が切れています。再発行してください。');
  }
  // タイミング攻撃耐性のある比較
  const ok = timingSafeStrEqual(code, req.session.mailCode);
  // 成否に関わらずコードは単回限り（リプレイ/総当たり防止）
  req.session.mailCode = null;
  req.session.mailCodeExpires = null;
  if (ok) {
    req.session.mailAttempts = 0;
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
