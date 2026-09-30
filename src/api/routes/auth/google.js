// src/api/routes/auth/google.js - Google OAuth2認証エンドポイント
const express = require('express');
const router = express.Router();
const UserRepository = require('../../../db/json/UserRepository');
const { APIError, ErrorTypes, asyncHandler } = require('../../../utils/error-handler');
const { v4: uuidv4 } = require('uuid');
const { signAccessToken, signRefreshToken } = require('../../utils/tokens');
const { authLimiter } = require('../../middleware/rate-limit');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// POST /api/v1/auth/google { idToken }
router.post('/', authLimiter, asyncHandler(async (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    throw new APIError(ErrorTypes.EXTERNAL_SERVICE, 'Google OAuth is not configured', 503);
  }
  const { idToken } = req.body;
  if (!idToken) throw new APIError(ErrorTypes.VALIDATION, 'idToken is required', 400);

  // google-auth-library は optional（googleapis と同様に未インストールの場合がある）
  let ticket;
  try {
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      throw new APIError(ErrorTypes.EXTERNAL_SERVICE, 'google-auth-library is not installed', 503);
    }
    throw new APIError(ErrorTypes.UNAUTHORIZED, 'Invalid Google ID token', 401);
  }

  const payload = ticket.getPayload();
  const { sub: googleId, email, name, picture } = payload;
  if (!email) throw new APIError(ErrorTypes.VALIDATION, 'Googleアカウントにメールがありません', 400);
  // email_verified が true でない Google アカウントを拒否する。
  // verifyIdToken はシグネチャ/audience/issuer を検証するが email_verified は確認しない。
  // Workspace 等では email_verified:false のまま有効な ID トークンが発行されるため、
  // 攻撃者が未確認メールアドレスで victim@corp.com の Strawberry アカウントを先取りできる。
  if (payload.email_verified !== true) {
    throw new APIError(ErrorTypes.UNAUTHORIZED, 'Google account email is not verified', 401);
  }

  // ユーザーDBに登録/取得
  let user = UserRepository.getByGoogleId(googleId);
  if (!user) {
    // メール重複チェック: 同じメールでパスワード登録済みの口座が既にあるなら、
    // Google 紐付けは別フローで明示的に行わせる。これがないと攻撃者が同名 Google
    // アカウントで新規 user 口座を作り、被害者のメール表示の裏で別 JWT を発行できる
    // （並行口座なりすまし）。
    const lowered = (email || '').toLowerCase();
    const conflict = UserRepository.getByEmail(lowered);
    if (conflict) {
      throw new APIError(
        ErrorTypes.CONFLICT,
        'Account with this email already exists; sign in with your password and link Google from settings',
        409,
      );
    }
    user = UserRepository.create({ googleId, email: lowered, name, picture, role: 'user' });
  }

  // アクセストークン（短命）+ リフレッシュトークン（長命）を発行。
  // パスワードログインと同一のペア構成にしないと、OAuth ユーザーは
  // アクセストークン（1h）切れのたび再ログインが必要になり、SPA の
  // サイレントリフレッシュ経路に乗らない。ati で access↔refresh を紐付け、
  // ローテーション時に旧アクセストークンも失効させる。
  const accessJti = uuidv4();
  const token = signAccessToken(user, accessJti);
  const refreshToken = signRefreshToken(user, accessJti);
  try {
    UserRepository.update(user.id, { lastLogin: new Date().toISOString() });
  } catch (_) { /* lastLogin 更新失敗はログイン自体を妨げない */ }
  res.json({ token, refreshToken, user: { id: user.id, email: user.email, name: user.name, picture: user.picture, role: user.role } });
}));

module.exports = router;
