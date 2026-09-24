// src/api/routes/user/admin.js - 管理者系エンドポイント
// （ユーザー一覧・単体取得・削除・ロール変更 — checkRole(['admin']) 配下）。
const express = require('express');
const router = express.Router();

const { asyncHandler } = require('../../../utils/error-handler');
const { parsePagination } = require('../../../utils/pagination');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');
const { sanitizeUser } = require('../../utils/sanitize-user');
const { invalidateUserCache } = require('../../middleware/cache');
const { appendAuditLog } = require('../../../utils/audit-log');
const GpuRepository = require('../../../db/json/GpuRepository');
const OrderRepository = require('../../../db/json/OrderRepository');
const UserRepository = require('../../../db/json/UserRepository');

router.get('/',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    logger.info('Fetching all users');
    let users = UserRepository.getAll();
    // 任意フィルタ（ロール・ステータス）
    if (req.query.role) users = users.filter(u => u.role === req.query.role);
    if (req.query.status) users = users.filter(u => u.status === req.query.status);
    const total = users.length;
    // ページネーション
    const { limit, offset } = parsePagination(req.query, { maxOffset: 100000 });
    const page = users.slice(offset, offset + limit);
    // パスワード・APIキー等の機密フィールドを除外
    const usersNoSecrets = page.map(sanitizeUser);
    res.json({
      message: 'Fetched all users',
      total,
      limit,
      offset,
      users: usersNoSecrets
    });
  })
);

// 特定ユーザーの情報取得 (管理者のみ)

router.get('/:id',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const userId = req.params.id;
    logger.info(`Fetching user details: ${userId}`);
    
    // ユーザーを検索（永続化対応）
    const user = UserRepository.getById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // パスワード・APIキー等を除外（GET /users リストと同一ポリシー。
    // 管理者でも他人の credential を平文で参照できてはならない）
    res.json(sanitizeUser(user));
  })
);

// ユーザー削除 (管理者のみ)

router.delete('/:id', 
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const userId = req.params.id;
    logger.info(`Deleting user: ${userId}`);
    // 自分自身は削除不可
    if (userId === req.user.id) {
      return res.status(403).json({ error: 'You cannot delete yourself' });
    }
    // 対象ユーザーを取得（最低1人の管理者を維持するため）
    const target = UserRepository.getById(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    // 最低1人アクティブ管理者維持: アクティブな管理者を削除すると 0 になる場合だけブロック。
    // 非アクティブ（deactivated）な管理者の削除はカウントに影響しないため許可する。
    if (target.role === 'admin' && target.status !== 'deactivated') {
      const adminCount = UserRepository.getAll().filter(u => u.role === 'admin' && u.status !== 'deactivated').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'At least one active admin must remain' });
      }
    }
    // 進行中の注文がある場合は削除不可（自己退会と同一ポリシー）。
    // 注文に参加中のユーザーをハード削除すると userId/providerId 参照が孤児化し、
    // 支払・係争・エスクロー処理が機能しなくなる。
    const NON_TERMINAL = new Set(['pending', 'matched', 'active', 'disputed']);
    const openOrders = OrderRepository.getAll().filter(o =>
      NON_TERMINAL.has(o.status) && (o.userId === userId || o.providerId === userId)
    );
    if (openOrders.length > 0) {
      return res.status(409).json({
        error: 'Cannot delete user with in-flight orders. Resolve them first.',
        openOrderCount: openOrders.length,
      });
    }
    // GPU リストが残存するプロバイダは削除不可。
    // GPU を削除せずにユーザーをハード削除すると、孤立した GPU がマーケットプレイスに
    // 残って新規注文を受け付け続け、providerId が解決できない注文・エスクローが生まれる。
    const providerGpus = GpuRepository.getAll().filter(g => g.providerId === userId);
    if (providerGpus.length > 0) {
      return res.status(409).json({
        error: 'Cannot delete user with registered GPU listings. Remove or transfer all GPU listings first.',
        gpuCount: providerGpus.length,
        gpuIds: providerGpus.map(g => g.id),
      });
    }
    // ユーザー削除（永続化対応）
    const deleted = UserRepository.delete(userId);
    if (!deleted) {
      return res.status(404).json({ error: 'User not found' });
    }
    logger.info(`User deleted: ${userId}`, { deletedBy: req.user.id });
    res.json({ message: 'User deleted successfully' });
  })
);

// ユーザーロール変更 (管理者のみ)

router.put('/:id/role', 
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const userId = req.params.id;
    const { role } = req.body;
    logger.info(`Changing role for user: ${userId}`);
    if (!role || !['user', 'provider', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Valid role is required' });
    }
    // 操作者のアクティブ状態を DB から再確認（停止済み管理者の古いトークンによる操作を防ぐ）
    const actingAdmin = UserRepository.getById(req.user.id);
    if (!actingAdmin || actingAdmin.status === 'deactivated' || actingAdmin.status === 'suspended') {
      return res.status(403).json({ error: 'Your account is not active' });
    }
    // 自分自身の降格禁止
    if (userId === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'You cannot remove your own admin role' });
    }
    // ユーザーを検索（既存バグ: 存在しない in-memory `users` 配列を参照し常に 500 だった）
    const target = UserRepository.getById(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    // 最低1人アクティブ管理者維持（非アクティブ管理者はカウント外）
    if (target.role === 'admin' && role !== 'admin') {
      const adminCount = UserRepository.getAll().filter(u => u.role === 'admin' && u.status !== 'deactivated').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'At least one active admin must remain' });
      }
    }
    // ロールを更新（永続化対応）
    // 降格（特に admin→user/provider）の場合はセッションを即時失効させる。
    // これにより旧トークンが admin 権限で使い続けられるウィンドウを閉じる。
    const now = new Date().toISOString();
    const roleDowngraded = target.role === 'admin' && role !== 'admin';
    const updated = UserRepository.update(userId, {
      role,
      updatedAt: now,
      ...(roleDowngraded ? { sessionsRevokedAt: now } : {}),
    });
    // 旧ロール時に書かれた per-user キャッシュ（GET /orders 等）を必ず無効化する。
    // role はキャッシュキーの一部だが、再ログイン後の userId は同一なので
    // role を変えてもキー衝突しないが、旧 role のエントリ自体が LRU に残ると不要にメモリを
    // 食う/監査タイムラインを撹乱するため、当該 user の全エントリをここで一掃する。
    try { invalidateUserCache(userId); } catch (_) {}
    if (roleDowngraded) {
      logger.warn(`Admin role revoked for user ${userId} by ${req.user.id} — sessions invalidated`);
    }
    logger.info(`Role changed for user: ${userId}`, {
      userId,
      newRole: role,
      changedBy: req.user.id
    });
    appendAuditLog('user_role_changed', {
      targetUserId: userId,
      previousRole: target.role,
      newRole: role,
      changedBy: req.user.id,
    }, req.user.id);
    res.json({
      message: 'User role updated successfully',
      user: {
        id: updated.id,
        username: updated.username,
        role: updated.role
      }
    });
  })
);


// 自分の GPU 価格ウォッチ一覧（GPU スナップショット付き）
// GET /users/me/watches — 認証必須
// N+1 問題の解消: クライアントが各 gpuId に対して GET /gpus/:id を個別に
// 呼ぶ（N+1 往復）のではなく、サーバー側で GPU 情報をジョインして返す。
// 削除済み GPU のウォッチは gpu:null として返す（クライアントが 404 を個別処理不要）。

module.exports = router;
