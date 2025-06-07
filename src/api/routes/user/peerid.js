// src/api/routes/user/peerid.js - ピアID管理API
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../../middleware/auth');
const UserRepository = require('../../../db/json/UserRepository');
const { APIError, ErrorTypes, asyncHandler } = require('../../../utils/error-handler');

// JWT認証必須
router.use(requireAuth);

// [POST] /api/user/peerid/link - ピアID紐付け
router.post('/link', asyncHandler(async (req, res) => {
  const { peerId } = req.body;
  if (!peerId) throw new APIError(ErrorTypes.VALIDATION, 'peerId is required', 400);
  const user = UserRepository.getById(req.user.id);
  if (!user) throw new APIError(ErrorTypes.AUTH, 'User not found', 404);
  user.peerId = peerId;
  UserRepository.update(user.id, user);
  res.json({ message: 'ピアIDを紐付けました', peerId });
}));

// [POST] /api/user/peerid/unlink - ピアID解除
router.post('/unlink', asyncHandler(async (req, res) => {
  const user = UserRepository.getById(req.user.id);
  if (!user) throw new APIError(ErrorTypes.AUTH, 'User not found', 404);
  user.peerId = null;
  UserRepository.update(user.id, user);
  res.json({ message: 'ピアIDの紐付けを解除しました' });
}));

// [GET] /api/user/peerid - 自分のピアID取得
router.get('/', asyncHandler(async (req, res) => {
  const user = UserRepository.getById(req.user.id);
  if (!user) throw new APIError(ErrorTypes.AUTH, 'User not found', 404);
  res.json({ peerId: user.peerId || null });
}));

// [GET] /api/admin/peerids - 管理者のみ全ユーザーのピアID一覧取得
router.get('/admin/all', requireRole('admin'), asyncHandler(async (req, res) => {
  const all = UserRepository.getAll().map(u => ({ id: u.id, email: u.email, peerId: u.peerId || null, role: u.role }));
  res.json({ users: all });
}));

module.exports = router;
