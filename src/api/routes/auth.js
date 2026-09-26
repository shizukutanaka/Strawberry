// auth.js - OAuth認証ルート（Google, GitHub, RESTful Google）
const express = require('express');
const router = express.Router();
const passport = require('../middleware/oauth');
const { masterSession } = require('../middleware/master-session');
const UserRepository = require('../../db/json/UserRepository');
const { v4: uuidv4 } = require('uuid');
const { signAccessToken, signRefreshToken } = require('../utils/tokens');
const { asyncHandler } = require('../../utils/error-handler');

// --- OAuth Web フローのセッション/CSRF 対策 ---
// passport-oauth2 の `state: true` は req.session（ステートストア）を必要とする。
// session なしで state を有効にすると strategy が例外を投げるため、web フローの
// 2ルートにのみ共有インスタンス masterSession を適用する（saveUninitialized:false
// なので state 書き込み時のみ Cookie が発行され、API リクエストには影響しない）。
// state が無いと login-CSRF が成立する: 攻撃者が開始した OAuth フローの callback を
// 被害者に踏ませ、被害者ブラウザが攻撃者アカウントのセッションを受け取る。
const oauthSession = [masterSession];

const providerEnabled = {
  google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  github: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
};
const ensureProviderEnabled = (name) => (req, res, next) => {
  if (!providerEnabled[name]) {
    return res.status(503).json({ error: `${name} OAuth is not configured` });
  }
  next();
};

/**
 * OAuth プロフィールから Strawberry アカウントを検索/作成し、トークンペアを発行する。
 * RESTful /auth/google（auth/google.js）と同一ポリシー:
 *  - 未検証メールは拒否（先取りアカウント乗っ取り防止）
 *  - 同一メールの既存パスワードアカウントがあれば 409（暗黙リンクはしない）
 *  - access+refresh ペア + ati 紐付け + lastLogin 更新
 * @returns {{status:number, body:object}}
 */
function completeOAuthLogin(provider, profile) {
  const providerKey = provider === 'github' ? 'githubId' : 'googleId';
  const providerId = profile && profile.id;
  const emailEntry = profile && Array.isArray(profile.emails) ? profile.emails[0] : null;
  const email = (emailEntry && emailEntry.value || '').toLowerCase();
  // GitHub の /user/emails は verified フラグを返す。Google は emails[].verified。
  // フラグが取れないプロバイダ/設定では false として扱い拒否側に倒す。
  const emailVerified = !!(emailEntry && emailEntry.verified === true);
  if (!providerId || !email) {
    return { status: 400, body: { error: 'OAuth profile has no email' } };
  }
  if (!emailVerified) {
    return { status: 401, body: { error: 'OAuth account email is not verified' } };
  }

  let user = provider === 'github'
    ? (UserRepository.getByGithubId ? UserRepository.getByGithubId(providerId) : null)
    : UserRepository.getByGoogleId(providerId);
  if (!user) {
    const conflict = UserRepository.getByEmail(email);
    if (conflict) {
      return {
        status: 409,
        body: { error: 'Account with this email already exists; sign in with your password and link the provider from settings' },
      };
    }
    user = UserRepository.create({
      [providerKey]: providerId,
      email,
      name: profile.displayName || (profile.name && profile.name.givenName) || email,
      picture: profile.photos && profile.photos[0] ? profile.photos[0].value : undefined,
      role: 'user',
    });
  }

  const accessJti = uuidv4();
  const token = signAccessToken(user, accessJti);
  const refreshToken = signRefreshToken(user, accessJti);
  try {
    UserRepository.update(user.id, { lastLogin: new Date().toISOString() });
  } catch (_) { /* lastLogin 更新失敗はログイン自体を妨げない */ }
  return {
    status: 200,
    body: {
      token,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture, role: user.role },
    },
  };
}

// Google OAuth (Webフロー)
router.get('/google', oauthSession, ensureProviderEnabled('google'),
  (req, res, next) => passport.authenticate('google', { scope: ['profile', 'email'], session: false, state: true })(req, res, next));
router.get('/google/callback', oauthSession, ensureProviderEnabled('google'),
  (req, res, next) => passport.authenticate('google', { session: false, state: true })(req, res, next),
  asyncHandler(async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Google authentication failed' });
    }
    const { status, body } = completeOAuthLogin('google', req.user);
    return res.status(status).json(body);
  })
);

// GitHub OAuth
router.get('/github', oauthSession, ensureProviderEnabled('github'),
  (req, res, next) => passport.authenticate('github', { scope: ['user:email'], session: false, state: true })(req, res, next));
router.get('/github/callback', oauthSession, ensureProviderEnabled('github'),
  (req, res, next) => passport.authenticate('github', { session: false, state: true })(req, res, next),
  asyncHandler(async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'GitHub authentication failed' });
    }
    const { status, body } = completeOAuthLogin('github', req.user);
    return res.status(status).json(body);
  })
);

// Google OAuth2 RESTful認証（POST /api/auth/google）
router.use('/google', require('./auth/google'));

module.exports = router;
module.exports._completeOAuthLogin = completeOAuthLogin;
