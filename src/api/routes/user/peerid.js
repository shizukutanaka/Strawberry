// src/api/routes/user/peerid.js - ピアID管理API
const express = require('express');
const router = express.Router();
const { authenticateJWT, checkRole } = require('../../middleware/security');
const UserRepository = require('../../../db/json/UserRepository');
const { APIError, ErrorTypes, asyncHandler } = require('../../../utils/error-handler');
const { withLock } = require('../../../utils/async-lock');

// JWT認証必須（全ルートに適用）
router.use(authenticateJWT);

// [POST] /api/v1/users/peerid/link - ピアID紐付け
router.post('/link', asyncHandler(async (req, res) => {
  const { peerId } = req.body;
  if (!peerId || typeof peerId !== 'string') throw new APIError(ErrorTypes.VALIDATION, 'peerId is required', 400);
  if (peerId.length > 256) throw new APIError(ErrorTypes.VALIDATION, 'peerId is too long', 400);
  // libp2p PeerID は Base58 または CIDv1 形式 (英数字・+/-/=)
  if (!/^[A-Za-z0-9+/=_:-]{1,256}$/.test(peerId)) {
    throw new APIError(ErrorTypes.VALIDATION, 'Invalid peerId format', 400);
  }
  const user = UserRepository.getById(req.user.id);
  if (!user) throw new APIError(ErrorTypes.NOT_FOUND, 'User not found', 404);
  // PeerID は P2P 上の身元そのもの。check-then-write 競合で同一 PeerID を 2 ユーザーが
  // 取得すると、相手の announceGPU/updateOrder トラフィックをすり替えられる。peerId 単位の
  // ロックで「重複チェック → 自分への割当」を直列化する。
  await withLock(`peerid:${peerId}`, async () => {
    const existingOwner = UserRepository.getByPeerId(peerId);
    if (existingOwner && existingOwner.id !== user.id) {
      throw new APIError(ErrorTypes.CONFLICT, 'PeerID is already registered to another user', 409);
    }
    UserRepository.update(user.id, { peerId });
  });
  res.json({ message: 'ピアIDを紐付けました', peerId });
}));

// [POST] /api/v1/users/peerid/unlink - ピアID解除
router.post('/unlink', asyncHandler(async (req, res) => {
  const user = UserRepository.getById(req.user.id);
  if (!user) throw new APIError(ErrorTypes.NOT_FOUND, 'User not found', 404);
  UserRepository.update(user.id, { peerId: null });
  res.json({ message: 'ピアIDの紐付けを解除しました' });
}));

// [GET] /api/v1/users/peerid - 自分のピアID取得
router.get('/', asyncHandler(async (req, res) => {
  const user = UserRepository.getById(req.user.id);
  if (!user) throw new APIError(ErrorTypes.NOT_FOUND, 'User not found', 404);
  res.json({ peerId: user.peerId || null });
}));

// [GET] /api/v1/users/peerid/admin/all - 管理者のみ全ユーザーのピアID一覧取得
// email は返さない: P2P identity (peerId) とメールアドレスを紐付けると全ユーザーの匿名性を
// 一括で破壊できる（管理者も最小権限原則に従い必要以上の PII を取得しない）。
router.get('/admin/all', checkRole(['admin']), asyncHandler(async (req, res) => {
  const all = UserRepository.getAll().map(u => ({ id: u.id, peerId: u.peerId || null, role: u.role }));
  res.json({ users: all });
}));

module.exports = router;
