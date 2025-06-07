// src/api/routes/auth/google.js - Google OAuth2認証エンドポイント
const express = require('express');
const router = express.Router();
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const UserRepository = require('../../../db/json/UserRepository');
const { APIError, ErrorTypes, asyncHandler } = require('../../../utils/error-handler');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET;
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// POST /api/auth/google { idToken }
router.post('/', asyncHandler(async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) throw new APIError(ErrorTypes.VALIDATION, 'idToken is required', 400);
  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  } catch (e) {
    throw new APIError(ErrorTypes.AUTH, 'Invalid Google ID token', 401);
  }
  const payload = ticket.getPayload();
  const { sub: googleId, email, name, picture } = payload;
  if (!email) throw new APIError(ErrorTypes.AUTH, 'Googleアカウントにメールがありません', 400);
  // ユーザーDBに登録/更新
  let user = UserRepository.getByGoogleId(googleId);
  if (!user) {
    user = UserRepository.create({ googleId, email, name, picture, role: 'user' });
  }
  // JWT発行
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, googleId }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, picture: user.picture, role: user.role } });
}));

module.exports = router;
