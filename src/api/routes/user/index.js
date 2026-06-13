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
    // 無効化済みアカウントはログイン不可（メール匿名化に加えた多層防御）
    if (user.status === 'deactivated') {
      logger.warn(`Login failed: account deactivated (${email})`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // パスワード検証
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      logger.warn(`Login failed: wrong password (${email})`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // アクセストークン（短命）+ リフレッシュトークン（長命）を発行。
    // jti は logout 時の失効に使用。type で両者を厳密分離。
    const { signAccessToken, signRefreshToken } = require('../../utils/tokens');
    const token = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    user.lastLogin = new Date().toISOString();
    logger.info(`Login success: ${email}`);
    // パスワードやAPIキーは絶対にレスポンス・ログに含めない
    res.json({
      message: 'Login successful',
      token,
      refreshToken
    });
  })
);

// アクセストークンの更新（リフレッシュトークンから新しいアクセストークンを発行）
router.post('/refresh',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({ error: 'refreshToken is required' });
    }
    let payload;
    try {
      payload = jwt.verify(refreshToken, resolveSecret(), { algorithms: ['HS256'] });
    } catch (_) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    // リフレッシュトークン以外（アクセストークン等）では更新不可
    if (payload.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    // logout で失効済み、または既に一度使用済みのリフレッシュトークンは拒否
    const { isRevoked, revoke } = require('../../middleware/token-denylist');
    if (payload.jti && isRevoked(payload.jti)) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    // ユーザーが削除/無効化されていないか確認（最新のロールも反映）
    const user = UserRepository.getById(payload.id);
    if (!user || user.status === 'deactivated') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    // 使い切り（single-use）: 使用済みリフレッシュトークンの jti を失効させることで
    // 同じトークンを再利用したリプレイアタックを防ぐ。
    if (payload.jti) {
      revoke(payload.jti, (payload.exp || 0) * 1000);
    }
    const { signAccessToken, signRefreshToken } = require('../../utils/tokens');
    const token = signAccessToken(user);
    const newRefreshToken = signRefreshToken(user);
    logger.info(`Access token refreshed for user: ${user.id}`);
    res.json({ message: 'Token refreshed', token, refreshToken: newRefreshToken });
  })
);

// ログアウト（トークン失効。認証必須）
router.post('/logout',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const { revoke } = require('../../middleware/token-denylist');
    // リフレッシュトークンが提供されていれば併せて失効（漏洩リフレッシュの無効化）
    const { refreshToken } = req.body || {};
    if (refreshToken && typeof refreshToken === 'string') {
      try {
        const rp = jwt.verify(refreshToken, resolveSecret(), { algorithms: ['HS256'] });
        if (rp.type === 'refresh' && rp.jti) {
          revoke(rp.jti, (rp.exp || 0) * 1000);
        }
      } catch (_) { /* 無効なリフレッシュトークンは無視（logout は冪等に成功させる） */ }
    }
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

// アカウント自己退会（ソフト無効化。認証必須）
// ハード削除はしない: 注文履歴・係争・監査証跡を保全しつつ、本人を確実にロックアウトする。
// メール/ユーザー名を匿名化して再ログイン・再利用を防ぎ、現在のアクセストークンを失効させる。
router.delete('/me',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const user = UserRepository.getById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.status === 'deactivated') {
      return res.status(409).json({ error: 'Account is already deactivated' });
    }
    // 最後の管理者は自己退会できない（管理不能化の防止。ロール変更と同一ポリシー）
    if (user.role === 'admin') {
      const adminCount = UserRepository.getAll().filter(u => u.role === 'admin' && u.status !== 'deactivated').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'At least one active admin must remain; transfer admin before deactivating' });
      }
    }
    const anonId = uuidv4();
    UserRepository.update(user.id, {
      status: 'deactivated',
      deactivatedAt: new Date().toISOString(),
      // 個人情報の匿名化（履歴の userId 参照は維持されるため注文・監査は保全される）
      email: `deactivated+${anonId}@invalid.local`,
      username: `deactivated_${anonId.slice(0, 8)}`,
      // パスワードを無効化（万一メールが復元されても認証不可）
      password: `!deactivated-${anonId}`,
      apiKey: null,
    });
    // 現在のアクセストークンを失効（exp まで保持）。本人の能動的ロックアウト。
    try {
      const { revoke } = require('../../middleware/token-denylist');
      if (req.user.jti) revoke(req.user.jti, (req.user.exp || 0) * 1000);
    } catch (e) {
      logger.warn(`token revoke on self-deactivation failed (user=${user.id}): ${e.message}`);
    }
    logger.info(`User self-deactivated account: ${user.id}`);
    res.json({ message: 'Account deactivated', userId: user.id });
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
    // ユーザー名の重複チェック（既に別ユーザーが使用している場合は 409）
    if (updateData.username && typeof updateData.username === 'string') {
      const existing = UserRepository.getAll().find(u => u.username === updateData.username && u.id !== req.user.id);
      if (existing) return res.status(409).json({ error: 'Username already taken' });
    }
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

// 自分のアクティビティフィード (認証必須)
// 注文（借り手・提供者）、GPU登録、レビュー受領を単一タイムラインに統合して返す。
// クエリ: ?limit=N (1-100, default 20) ?offset=N ?type=order_renter|order_provider|gpu_registered|review_received
router.get('/me/activity',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const typeFilter = req.query.type || null;
    const VALID_TYPES = new Set(['order_renter', 'order_provider', 'gpu_registered', 'review_received']);
    if (typeFilter && !VALID_TYPES.has(typeFilter)) {
      return res.status(400).json({ error: `Invalid type filter. Valid values: ${[...VALID_TYPES].join(', ')}` });
    }

    const OrderRepository = require('../../../db/json/OrderRepository');
    const GpuRepository = require('../../../db/json/GpuRepository');
    const allOrders = OrderRepository.getAll();

    const events = [];

    if (!typeFilter || typeFilter === 'order_renter') {
      for (const order of allOrders.filter(o => o.userId === userId)) {
        events.push({
          type: 'order_renter',
          timestamp: order.createdAt,
          orderId: order.id,
          gpuId: order.gpuId || null,
          status: order.status,
          durationMinutes: order.durationMinutes,
          totalPrice: order.totalPrice || null,
        });
      }
    }

    if (!typeFilter || typeFilter === 'order_provider') {
      for (const order of allOrders.filter(o => o.providerId === userId)) {
        events.push({
          type: 'order_provider',
          timestamp: order.createdAt,
          orderId: order.id,
          gpuId: order.gpuId || null,
          status: order.status,
          durationMinutes: order.durationMinutes,
          totalPrice: order.totalPrice || null,
        });
      }
    }

    if (!typeFilter || typeFilter === 'gpu_registered') {
      for (const gpu of GpuRepository.getAll().filter(g => g.providerId === userId)) {
        events.push({
          type: 'gpu_registered',
          timestamp: gpu.createdAt,
          gpuId: gpu.id,
          name: gpu.name,
          model: gpu.model,
          vendor: gpu.vendor,
        });
      }
    }

    if (!typeFilter || typeFilter === 'review_received') {
      for (const order of allOrders) {
        // 借り手として受けたレビュー（提供者→借り手）
        if (order.userId === userId && order.renterReview) {
          events.push({
            type: 'review_received',
            timestamp: order.renterReview.reviewedAt || order.updatedAt || order.createdAt,
            orderId: order.id,
            rating: order.renterReview.rating,
            comment: order.renterReview.comment || null,
            reviewedBy: order.providerId || null,
          });
        }
        // 提供者として受けたレビュー（借り手→提供者）
        if (order.providerId === userId && order.review) {
          events.push({
            type: 'review_received',
            timestamp: order.review.reviewedAt || order.updatedAt || order.createdAt,
            orderId: order.id,
            rating: order.review.rating,
            comment: order.review.comment || null,
            reviewedBy: order.userId || null,
          });
        }
      }
    }

    // 新しい順にソートしてページネーション
    events.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    const total = events.length;
    const page = events.slice(offset, offset + limit);

    res.json({ total, limit, offset, events: page });
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

// プロバイダ公開レピュテーション (認証不要 — マーケットプレイスの信頼判断材料)。
// reputation-scorer の score/tier（完了/失敗/監査/SLA/スラッシュ由来）に加え、
// 当該プロバイダの全 GPU に対するレビュー集計（平均★・件数）と取引実績を返す。
// レピュテーションスコアの簡易インメモリキャッシュ（TTL: 5分）
// 同一プロバイダへの連続リクエストでの O(n) 集計を避ける。
const _reputationCache = new Map(); // providerId → { data, expiresAt }
const REPUTATION_CACHE_TTL_MS = 5 * 60 * 1000;

router.get('/:id/reputation', asyncHandler(async (req, res) => {
  const providerId = req.params.id;
  const user = UserRepository.getById(providerId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // キャッシュヒット確認
  const cached = _reputationCache.get(providerId);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.data);
  }

  const { createReputationService } = require('../../../reputation/reputation-service');
  const repSvc = createReputationService();
  const { score, tier, components } = repSvc.getScore(providerId);
  const stats = repSvc.getStats(providerId);

  // 当該プロバイダのオーダーからレビュー★と取引実績を集計
  const OrderRepository = require('../../../db/json/OrderRepository');
  const orders = OrderRepository.getAll().filter(o => o.providerId === providerId);
  const reviewed = orders.filter(o => o.review);
  const reviewCount = reviewed.length;
  const ratingAverage = reviewCount > 0
    ? Math.round((reviewed.reduce((s, o) => s + o.review.rating, 0) / reviewCount) * 10) / 10
    : null;
  const completedOrders = orders.filter(o => o.status === 'completed').length;
  const rejectedOrders = orders.filter(o => o.cancelReason === 'provider_rejected').length;

  // 借り手としての受領評価（プロバイダ→借り手レビューの集計）。これにより
  // プロバイダが投稿する借り手評価が実際に閲覧可能になり、難あり借り手が可視化される。
  const asRenter = OrderRepository.getAll().filter(o => o.userId === providerId && o.renterReview);
  const renterReviewCount = asRenter.length;
  const renterRatingAverage = renterReviewCount > 0
    ? Math.round((asRenter.reduce((s, o) => s + o.renterReview.rating, 0) / renterReviewCount) * 10) / 10
    : null;

  const data = {
    providerId,
    score,
    tier,
    components,
    stats,
    ratingAverage,
    reviewCount,
    completedOrders,
    rejectedOrders,
    renterRatingAverage,
    renterReviewCount,
    memberSince: user.createdAt || null,
  };
  // キャッシュに保存（テスト環境ではキャッシュしない — レピュテーション変化を即時反映したい）
  if (process.env.NODE_ENV !== 'test') {
    _reputationCache.set(providerId, { data, expiresAt: Date.now() + REPUTATION_CACHE_TTL_MS });
  }
  res.json(data);
}));

// 借り手公開プロフィール（認証不要 — プロバイダが注文受付前に借り手を調査できる）。
// 受領したプロバイダ→借り手レビューの集計（平均★・件数）と取引実績を返す。
// 無効化済みユーザーは 404 で応答し PII を漏洩しない。
router.get('/:id/renter-profile', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const user = UserRepository.getById(userId);
  if (!user || user.status === 'deactivated') {
    return res.status(404).json({ error: 'User not found' });
  }

  const OrderRepository = require('../../../db/json/OrderRepository');
  const renterOrders = OrderRepository.getAll().filter(o => o.userId === userId && o.renterReview);
  const reviewCount = renterOrders.length;
  const ratingAverage = reviewCount > 0
    ? Math.round((renterOrders.reduce((s, o) => s + o.renterReview.rating, 0) / reviewCount) * 10) / 10
    : null;
  // 直近5件のレビュー（最新順）
  const recentReviews = renterOrders
    .sort((a, b) => (b.renterReview.reviewedAt || '').localeCompare(a.renterReview.reviewedAt || ''))
    .slice(0, 5)
    .map(o => ({ orderId: o.id, rating: o.renterReview.rating, comment: o.renterReview.comment || null, reviewedAt: o.renterReview.reviewedAt }));

  const completedOrders = OrderRepository.getAll().filter(o => o.userId === userId && o.status === 'completed').length;

  res.json({
    userId,
    ratingAverage,
    reviewCount,
    completedOrders,
    recentReviews,
    memberSince: user.createdAt || null,
  });
}));

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
    // 最低1人アクティブ管理者維持: アクティブな管理者を削除すると 0 になる場合だけブロック。
    // 非アクティブ（deactivated）な管理者の削除はカウントに影響しないため許可する。
    if (target.role === 'admin' && target.status !== 'deactivated') {
      const adminCount = UserRepository.getAll().filter(u => u.role === 'admin' && u.status !== 'deactivated').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'At least one active admin must remain' });
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
    // 最低1人アクティブ管理者維持（非アクティブ管理者はカウント外）
    if (target.role === 'admin' && role !== 'admin') {
      const adminCount = UserRepository.getAll().filter(u => u.role === 'admin' && u.status !== 'deactivated').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'At least one active admin must remain' });
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
