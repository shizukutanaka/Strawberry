// src/api/routes/auth/google.js - Google OAuth2認証エンドポイント
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const UserRepository = require('../../../db/json/UserRepository');
const { APIError, ErrorTypes, asyncHandler } = require('../../../utils/error-handler');
const { resolveSecret } = require('../../middleware/jwt-auth');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// POST /api/v1/auth/google { idToken }
router.post('/', asyncHandler(async (req, res) => {
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

  // ユーザーDBに登録/取得
  let user = UserRepository.getByGoogleId(googleId);
  if (!user) {
    user = UserRepository.create({ googleId, email, name, picture, role: 'user' });
  }

  // JWT発行（resolveSecret で署名鍵を統一）
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, googleId },
    resolveSecret(),
    { expiresIn: '7d', algorithm: 'HS256' }
  );
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, picture: user.picture, role: user.role } });
}));

module.exports = router;
