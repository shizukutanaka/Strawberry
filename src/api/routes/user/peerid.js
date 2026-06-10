// src/api/routes/user/peerid.js - ピアID管理API
const express = require('express');
const router = express.Router();
const { authenticateJWT, checkRole } = require('../../middleware/security');
const UserRepository = require('../../../db/json/UserRepository');
const { APIError, ErrorTypes, asyncHandler } = require('../../../utils/error-handler');

// JWT認証必須（全ルートに適用）
router.use(authenticateJWT);

// [POST] /api/v1/users/peerid/link - ピアID紐付け
router.post('/link', asyncHandler(async (req, res) => {
  const { peerId } = req.body;
  if (!peerId) throw new APIError(ErrorTypes.VALIDATION, 'peerId is required', 400);
  const user = UserRepository.getById(req.user.id);
  if (!user) throw new APIError(ErrorTypes.NOT_FOUND, 'User not found', 404);
  UserRepository.update(user.id, { ...user, peerId });
  res.json({ message: 'ピアIDを紐付けました', peerId });
}));

// [POST] /api/v1/users/peerid/unlink - ピアID解除
router.post('/unlink', asyncHandler(async (req, res) => {
  const user = UserRepository.getById(req.user.id);
  if (!user) throw new APIError(ErrorTypes.NOT_FOUND, 'User not found', 404);
  UserRepository.update(user.id, { ...user, peerId: null });
  res.json({ message: 'ピアIDの紐付けを解除しました' });
}));

// [GET] /api/v1/users/peerid - 自分のピアID取得
router.get('/', asyncHandler(async (req, res) => {
  const user = UserRepository.getById(req.user.id);
  if (!user) throw new APIError(ErrorTypes.NOT_FOUND, 'User not found', 404);
  res.json({ peerId: user.peerId || null });
}));

// [GET] /api/v1/users/peerid/admin/all - 管理者のみ全ユーザーのピアID一覧取得
router.get('/admin/all', checkRole(['admin']), asyncHandler(async (req, res) => {
  const all = UserRepository.getAll().map(u => ({ id: u.id, email: u.email, peerId: u.peerId || null, role: u.role }));
  res.json({ users: all });
}));

module.exports = router;
