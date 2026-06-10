// src/api/routes/user/index.js - ユーザー関連APIルート
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas, Joi } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');
const { config } = require('../../../utils/config');
// 署名鍵は検証側（jwt-auth/security）と同一の resolveSecret で解決する。
// 別経路で解決すると JWT_SECRET 設定時に署名と検証で鍵が食い違いログイン不能になる。
const { resolveSecret } = require('../../middleware/jwt-auth');

const { sanitizeObject } = require('../../../utils/sanitize');

const { authLimiter } = require('../../middleware/rate-limit');

// ファイルベースJSONストレージリポジトリ
const UserRepository = require('../../../db/json/UserRepository');
// ピアID管理サブルート
const peeridRouter = require('./peerid');

// ユーザー登録
router.post('/register',
  authLimiter,
  validateMiddleware(schemas.user.register),
  asyncHandler(async (req, res) => {
    // 入力値サニタイズ
    const sanitized = sanitizeObject(req.validatedBody, ['username', 'email']);
    const { username, email, password, role } = sanitized;
    // 自己登録では 'user' または 'provider' のみ許可（admin への昇格は管理者が行う）
    const assignedRole = (role === 'provider') ? 'provider' : 'user';
    logger.info(`Registering new user: ${username}`);
    // メールアドレス・ユーザー名の重複チェック
    if (UserRepository.getByEmail(email)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    if (UserRepository.getByUsername(username)) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    // パスワードハッシュ化
    const salt = await bcrypt.genSalt(config.security.bcryptRounds);
    const hashedPassword = await bcrypt.hash(password, salt);
    // 新規ユーザー作成
    const newUser = UserRepository.create({
      username,
      email,
      password: hashedPassword,
      role: assignedRole,
      lastLogin: null,
      settings: {
        notifications: true,
        theme: 'light'
      }
    });
    // レスポンス用にパスワードを削除
    const userResponse = { ...newUser };
    delete userResponse.password;
    // ユーザー登録をログに記録（既存バグ: 未定義の userId を参照し登録毎にクラッシュしていた）
    logger.info(`User registered: ${newUser.id}`, {
      userId: newUser.id,
      username,
      role: newUser.role
    });
    res.status(201).json({
      message: 'User registered successfully',
      user: userResponse
    });
  })
);

// ログイン
router.post('/login',
  authLimiter,
  validateMiddleware(schemas.user.login),
  asyncHandler(async (req, res) => {
    const { email, password } = req.validatedBody;
    logger.info(`Login attempt: ${email}`);
    // ユーザーを検索（永続化対応）
    const user = UserRepository.getByEmail(email);
    if (!user) {
      logger.warn(`Login failed: user not found (${email})`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // パスワード検証
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      logger.warn(`Login failed: wrong password (${email})`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // JWTトークン生成（jti は logout 時の失効に使用）
    const token = jwt.sign({ id: user.id, role: user.role, jti: uuidv4() }, resolveSecret(), { expiresIn: config.security.jwtExpiresIn });
    user.lastLogin = new Date().toISOString();
    logger.info(`Login success: ${email}`);
    // パスワードやAPIキーは絶対にレスポンス・ログに含めない
    res.json({
      message: 'Login successful',
      token
    });
  })
);

// ログアウト（トークン失効。認証必須）
router.post('/logout',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const { revoke } = require('../../middleware/token-denylist');
    if (req.user.jti) {
      // exp（秒）をミリ秒に変換して保持期限とする。それ以降は自然失効するため保持不要。
      revoke(req.user.jti, (req.user.exp || 0) * 1000);
      logger.info(`User logged out (token revoked): ${req.user.id}`);
      return res.json({ message: 'Logged out successfully' });
    }
    // jti の無い旧トークンは失効リストに載せられない（exp までは有効なまま）
    res.json({ message: 'Logged out (token issued before revocation support; it will expire naturally)' });
  })
);

// 現在のユーザー情報取得 (認証必須)
router.get('/me',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    logger.info(`Fetching user profile: ${req.user.id}`);
    
    // ユーザーを検索（永続化対応）
    const user = UserRepository.getById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // レスポンス用にパスワードを削除
    const userResponse = { ...user };
    delete userResponse.password;
    res.json(userResponse);
  })
);

// ユーザー情報更新 (認証必須)
router.put('/me', 
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const updateData = req.body;
    logger.info(`Updating user profile: ${req.user.id}`);
    
    // ユーザーを検索（永続化対応）
    const user = UserRepository.getById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // 更新不可のフィールドを削除
    delete updateData.id;
    delete updateData.email;
    delete updateData.password;
    delete updateData.role;
    delete updateData.createdAt;
    // ユーザー情報を更新
    const updatedUser = UserRepository.update(req.user.id, {
      ...updateData,
      updatedAt: new Date().toISOString()
    });
    // レスポンス用にパスワードを削除
    const userResponse = { ...updatedUser };
    delete userResponse.password;
    res.json({
      message: 'User profile updated successfully',
      user: userResponse
    });
  })
);

// パスワード変更 (認証必須)
router.put('/me/password',
  authLimiter,
  authenticateJWT,
  validateMiddleware(Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: Joi.string()
      .min(8)
      .pattern(/[a-z]/, 'lowercase')
      .pattern(/[A-Z]/, 'uppercase')
      .pattern(/[0-9]/, 'number')
      .pattern(/[^a-zA-Z0-9]/, 'symbol')
      .required()
      .messages({
        'string.pattern.name': 'Password must include at least one {#name} character',
        'string.min': 'Password must be at least 8 characters long'
      })
  }), 'body'),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    logger.info(`Changing password for user: ${req.user.id}`);
    // ユーザーを検索（永続化対応）
    const user = UserRepository.getById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // 現在のパスワードを検証
    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    // 新しいパスワードをハッシュ化
    const salt = await bcrypt.genSalt(config.security.bcryptRounds);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    // パスワードを更新
    UserRepository.update(req.user.id, {
      password: hashedPassword,
      updatedAt: new Date().toISOString()
    });
    logger.info(`Password changed for user: ${req.user.id}`);
    res.json({ message: 'Password changed successfully' });
  })
);

// 許可された設定キーのみ受け付ける（任意キーの書き込みを防ぐ）
const ALLOWED_SETTINGS_KEYS = new Set(['notifications', 'theme', 'language', 'timezone', 'currency']);

// ユーザー設定更新 (認証必須)
router.put('/me/settings',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Settings must be an object' });
    }
    const settings = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => ALLOWED_SETTINGS_KEYS.has(k))
    );
    logger.info(`Updating settings for user: ${req.user.id}`);
    
    // ユーザーを検索（永続化対応）
    const user = UserRepository.getById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // 設定を更新
    const updatedUser = UserRepository.update(req.user.id, {
      settings: {
        ...user.settings,
        ...settings
      },
      updatedAt: new Date().toISOString()
    });
    res.json({
      message: 'Settings updated successfully',
      settings: updatedUser.settings
    });
  })
);

// ユーザー一覧取得 (管理者のみ)
router.get('/', 
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    logger.info('Fetching all users');
    // パスワード・APIキーを除外
    const allUsers = UserRepository.getAll();
    const usersNoSecrets = allUsers.map(u => {
      const { password, apiKey, ...rest } = u;
      return rest;
    });
    res.json({
      message: 'Fetched all users',
      total: usersNoSecrets.length,
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
    // パスワードを除外
    const { password, ...userWithoutPassword } = user;
    res.json(userWithoutPassword);
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
    // 最低1人管理者維持
    if (target.role === 'admin') {
      const adminCount = UserRepository.getAll().filter(u => u.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'At least one admin must remain' });
      }
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
    // 自分自身の降格禁止
    if (userId === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'You cannot remove your own admin role' });
    }
    // ユーザーを検索（既存バグ: 存在しない in-memory `users` 配列を参照し常に 500 だった）
    const target = UserRepository.getById(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    // 最低1人管理者維持
    if (target.role === 'admin' && role !== 'admin') {
      const adminCount = UserRepository.getAll().filter(u => u.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'At least one admin must remain' });
      }
    }
    // ロールを更新（永続化対応）
    const updated = UserRepository.update(userId, {
      role,
      updatedAt: new Date().toISOString()
    });
    logger.info(`Role changed for user: ${userId}`, {
      userId,
      newRole: role,
      changedBy: req.user.id
    });
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

// ピアID管理 /api/v1/users/peerid/*
router.use('/peerid', peeridRouter);

module.exports = router;
