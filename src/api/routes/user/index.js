// src/api/routes/user/index.js - ユーザー関連APIルート
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');
const { config } = require('../../../utils/config');

// ファイルベースJSONストレージリポジトリ
const UserRepository = require('../../../db/json/UserRepository');

// ユーザー登録
router.post('/register', 
  validateMiddleware(schemas.user.register),
  asyncHandler(async (req, res) => {
    // 入力値サニタイズ
    const sanitized = sanitizeObject(req.validatedBody, ['username', 'email']);
    const { username, email, password, role } = sanitized;
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
      role: role || 'user',
      lastLogin: null,
      settings: {
        notifications: true,
        theme: 'light'
      }
    });
    // レスポンス用にパスワードを削除
    const userResponse = { ...newUser };
    delete userResponse.password;
    // ユーザー登録をログに記録
    logger.info(`User registered: ${userId}`, {
      userId,
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
    // JWTトークン生成
    const token = jwt.sign({ id: user.id, role: user.role }, config.security.jwtSecret, { expiresIn: config.security.jwtExpiresIn });
    user.lastLogin = new Date().toISOString();
    logger.info(`Login success: ${email}`);
    // パスワードやAPIキーは絶対にレスポンス・ログに含めない
    res.json({
      message: 'Login successful',
      token
    });
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

// ユーザー設定更新 (認証必須)
router.put('/me/settings', 
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const settings = req.body;
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

const { apiKeyAuth } = require('../../middleware/security');
const { sanitizeObject } = require('../../../utils/sanitize');

// ユーザー一覧取得 (管理者のみ)
router.get('/', 
  apiKeyAuth,
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
  apiKeyAuth,
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    const userId = req.params.id;
    logger.info(`Deleting user: ${userId}`);
    // 自分自身は削除不可
    if (userId === req.user.id) {
      return res.status(403).json({ error: 'You cannot delete yourself' });
    }
    // ユーザー削除（永続化対応）
    const deleted = UserRepository.delete(userId);
    if (!deleted) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'User deleted successfully' });
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account as admin' });
    }
    // ユーザーを検索
    const userIndex = users.findIndex(user => user.id === userId);
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }
    // 最低1人管理者維持
    if (users[userIndex].role === 'admin') {
      const adminCount = users.filter(u => u.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'At least one admin must remain' });
      }
    }
    // ユーザーを削除
    users.splice(userIndex, 1);
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
    // ユーザーを検索
    const userIndex = users.findIndex(user => user.id === userId);
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }
    // 最低1人管理者維持
    if (users[userIndex].role === 'admin' && role !== 'admin') {
      const adminCount = users.filter(u => u.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'At least one admin must remain' });
      }
    }
    // ロールを更新
    users[userIndex].role = role;
    users[userIndex].updatedAt = new Date().toISOString();
    logger.info(`Role changed for user: ${userId}`, {
      userId,
      newRole: role,
      changedBy: req.user.id
    });
    res.json({
      message: 'User role updated successfully',
      user: {
        id: users[userIndex].id,
        username: users[userIndex].username,
        role: users[userIndex].role
      }
    });
  })
);

module.exports = router;
