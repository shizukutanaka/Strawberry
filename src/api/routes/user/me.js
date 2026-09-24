// src/api/routes/user/me.js - セルフサービス系エンドポイント
// （/me プロフィール・パスワード変更・アクティビティ・ウォッチ・アカウント削除）。
const express = require('express');
const router = express.Router();

const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, Joi } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT } = require('../../middleware/security');
const { config } = require('../../../utils/config');
const { sanitizeString } = require('../../../utils/sanitize');
const { sanitizeUser } = require('../../utils/sanitize-user');
const { authLimiter } = require('../../middleware/rate-limit');
const { appendAuditLog } = require('../../../utils/audit-log');
const { isSessionInvalidated } = require('../../utils/session-invalidation');
const { revoke } = require('../../middleware/token-denylist');
const GpuRepository = require('../../../db/json/GpuRepository');
const WatchRepository = require('../../../db/json/WatchRepository');
const OrderRepository = require('../../../db/json/OrderRepository');
const UserRepository = require('../../../db/json/UserRepository');

const ALLOWED_PROFILE_FIELDS = {
  username:    v => typeof v === 'string' && v.length >= 3 && v.length <= 30 && /^[a-zA-Z0-9_-]+$/.test(v),
  displayName: v => typeof v === 'string' && v.length <= 50,
  bio:         v => typeof v === 'string' && v.length <= 500,
  // website: http/https のみ許可。javascript: / data: URI はフロントエンドで <a href> 等に
  // 展開されると Stored XSS になる。空文字（削除）は許可。
  website:     v => v === '' || (typeof v === 'string' && v.length <= 200 && /^https?:\/\//i.test(v)),
  location:    v => typeof v === 'string' && v.length <= 100,
  // avatar: http/https または data:image/(raster) のみ許可。
  // data:image/svg+xml は SVG 内に <script> を埋め込み可能なため拒否する。
  // <object>/<embed> で表示されると Stored XSS になる（<img> はブラウザが制限するが完全ではない）。
  // base64, を必須にして URL エンコードされた SVG インジェクションも防ぐ。
  avatar:      v => v === '' || (typeof v === 'string' && v.length <= 500 &&
                    (/^https?:\/\//i.test(v) ||
                     /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,/i.test(v))),
  // payoutAddress: プロバイダ（貸し手）が受取に使う Lightning / on-chain アドレス。
  // 決済(btc-onchain)はこの登録済みアドレスを「正」として使い、リクエストボディで
  // 送金先を差し替えられる詐称・妨害(借り手が貸し手への payout を別アドレスへ流す)を防ぐ。
  // 形式はプロバイダ依存(bolt11/LNURL/オンチェーン)のため緩めに検証。空文字で削除可。
  payoutAddress: v => v === '' || (typeof v === 'string' && v.length >= 10 && v.length <= 500 && !/\s/.test(v)),
};


router.get('/me',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    logger.info(`Fetching user profile: ${req.user.id}`);
    
    // ユーザーを検索（永続化対応）
    const user = UserRepository.getById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // レスポンス用に機密フィールド(password/apiKey 等)を一括除去
    res.json(sanitizeUser(user));
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
    // 進行中の注文を残したまま退会させない（GPU削除の "active orders first" と同一ポリシー）。
    // 放置すると、レンターとしての注文はプロバイダのGPUを幽霊ユーザーで占有し続け、
    // プロバイダとしての注文はレンターの進行中レンタルを宙吊りにする。本人が先に
    // 解決（完了/キャンセル）する必要がある。終端状態 = completed / cancelled。
    const NON_TERMINAL = new Set(['pending', 'matched', 'active', 'disputed']);
    const openOrders = OrderRepository.getAll().filter(o =>
      NON_TERMINAL.has(o.status) && (o.userId === user.id || o.providerId === user.id)
    );
    if (openOrders.length > 0) {
      return res.status(409).json({
        error: 'Cannot deactivate while you have in-flight orders. Complete or cancel them first.',
        openOrderCount: openOrders.length,
      });
    }
    const anonId = uuidv4();
    const deactivatedAt = new Date().toISOString();
    UserRepository.update(user.id, {
      status: 'deactivated',
      deactivatedAt,
      // 全セッション無効化: 退会時に他デバイスで発行済みのアクセストークンを
      // isSessionInvalidated() で拒否させる。これがないと、退会後も最大 TTL（1時間）
      // 分だけ他デバイスのトークンが有効なままになる（盗取済みトークンを含む）。
      sessionsRevokedAt: deactivatedAt,
      // 個人情報の匿名化（履歴の userId 参照は維持されるため注文・監査は保全される）
      email: `deactivated+${anonId}@invalid.local`,
      username: `deactivated_${anonId.slice(0, 8)}`,
      // パスワードを無効化（万一メールが復元されても認証不可）
      password: `!deactivated-${anonId}`,
      apiKey: null,
    });
    // 現在のアクセストークンを失効（exp まで保持）。本人の能動的ロックアウト。
    try {
      if (req.user.jti) revoke(req.user.jti, req.user.exp ? req.user.exp * 1000 : Date.now() + 24 * 60 * 60 * 1000);
    } catch (e) {
      logger.warn(`token revoke on self-deactivation failed (user=${user.id}): ${e.message}`);
    }
    // 価格ウォッチの後始末: 退会したユーザーのウォッチは二度と行動可能にならず
    // （ログイン不可）、watches.json に永久に残るストレージリークになる。さらに
    // notifyPriceWatchers が値下げ毎に死んだアカウントへの通知を試み続け無駄が生じる。
    // GPU 削除時の孤児ウォッチ掃除（gpu/index.js DELETE /:id）と対称の後始末。
    try {
      const userWatches = WatchRepository.getByUser(user.id) || [];
      for (const w of userWatches) {
        try { WatchRepository.delete(w.id); } catch (_) {}
      }
    } catch (_) { /* ウォッチ後始末の失敗で退会レスポンスを妨げない */ }

    logger.info(`User self-deactivated account: ${user.id}`);
    res.json({ message: 'Account deactivated', userId: user.id });
  })
);

// ユーザー情報更新 (認証必須)
// 許可するプロフィールフィールドの明示的な allowlist。
// 削除ベース (delete updateData.sensitive) では新フィールド追加時に漏れが生じるため、
// 許可リストベースに切り替え: 未知のフィールドは無視して inject を防止する。

router.put('/me',
  authLimiter,
  authenticateJWT,
  asyncHandler(async (req, res) => {
    logger.info(`Updating user profile: ${req.user.id}`);
    const user = UserRepository.getById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // 退会済みアカウントがレガシートークン（jti なし）を使って payout address 等を
    // 変更し資金を横取りする攻撃を防ぐ。
    if (user.status === 'deactivated') {
      return res.status(403).json({ error: 'Account is deactivated. Contact support to reactivate.' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }
    // 許可フィールドのみを抽出・検証（値の型も確認）
    // displayName/bio/location はフリーテキストのため HTML タグを除去してから保存する。
    // review comment と同じく sanitizeString を適用し、<script> 等の Stored XSS を防ぐ。
    
    const HTML_TEXT_FIELDS = new Set(['displayName', 'bio', 'location']);
    const updateData = {};
    for (const [field, validate] of Object.entries(ALLOWED_PROFILE_FIELDS)) {
      if (field in req.body) {
        if (!validate(req.body[field])) {
          return res.status(400).json({ error: `Invalid value for field: ${field}` });
        }
        updateData[field] = HTML_TEXT_FIELDS.has(field) ? sanitizeString(req.body[field]) : req.body[field];
      }
    }
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: `No updatable fields provided. Allowed: ${Object.keys(ALLOWED_PROFILE_FIELDS).join(', ')}` });
    }
    // ユーザー名の重複チェック
    if (updateData.username) {
      const existing = UserRepository.getAll().find(u => u.username === updateData.username && u.id !== req.user.id);
      if (existing) return res.status(409).json({ error: 'Username already taken' });
    }
    const updatedUser = UserRepository.update(req.user.id, {
      ...updateData,
      updatedAt: new Date().toISOString()
    });
    // Audit log for security-sensitive field changes (payout address, username).
    if (updateData.payoutAddress !== undefined) {
      appendAuditLog('user_payout_address_changed', { userId: req.user.id }, req.user.id);
    }
    res.json({
      message: 'User profile updated successfully',
      user: sanitizeUser(updatedUser)
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
      // bcrypt の 72 バイト切り詰め対策（register と同一ポリシー）。
      .max(72)
      .pattern(/[a-z]/, 'lowercase')
      .pattern(/[A-Z]/, 'uppercase')
      .pattern(/[0-9]/, 'number')
      .pattern(/[^a-zA-Z0-9]/, 'symbol')
      .required()
      .messages({
        'string.pattern.name': 'Password must include at least one {#name} character',
        'string.min': 'Password must be at least 8 characters long',
        'string.max': 'Password must be at most 72 characters long'
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
    // passwordChangedAt を記録し、iat がこれより古いトークンを全無効化する。
    // jti 失効（denylist）はログアウトした1トークンのみを対象にするが、
    // passwordChangedAt は他端末・盗難トークンを含むすべての既存セッションを無効化する。
    const changedAt = new Date().toISOString();
    UserRepository.update(req.user.id, {
      password: hashedPassword,
      updatedAt: changedAt,
      passwordChangedAt: changedAt,
      // sessionsRevokedAt も同時更新（多層防御）: passwordChangedAt だけでも
      // isSessionInvalidated() が全既存トークンを弾くが、sessionsRevokedAt を
      // 独立フィールドとして同時に立てることで、将来いずれかのフィールドが
      // クリアされても無効化が維持される。
      sessionsRevokedAt: changedAt,
    });
    // 現在のアクセストークンも即時失効（他セッションは passwordChangedAt で弾かれるが、
    // 本リクエストで使ったトークンは iat が同秒になる可能性があるため denylist でも対処）
    try {
      if (req.user.jti) revoke(req.user.jti, req.user.exp ? req.user.exp * 1000 : Date.now() + 24 * 60 * 60 * 1000);
    } catch (_) { /* denylist 失敗は更新を妨げない */ }
    logger.info(`Password changed for user: ${req.user.id}`);
    appendAuditLog('user_password_changed', { userId: req.user.id }, req.user.id);
    res.json({ message: 'Password changed successfully' });
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
        // reviewedBy は Probe 33 fix の bypassを防ぐため除去:
        // order.providerId をここで返すとレビュー投稿者の UUID が露出し、
        // /orders 一覧側で reviewerId を剥がした効果が失われる。
        if (order.userId === userId && order.renterReview) {
          events.push({
            type: 'review_received',
            timestamp: order.renterReview.reviewedAt || order.updatedAt || order.createdAt,
            orderId: order.id,
            rating: order.renterReview.rating,
            comment: order.renterReview.comment || null,
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
// ページネーション: ?limit=50&offset=0 — 上限200, 既定50

router.get('/me/watches',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const watches = WatchRepository.getByUser(req.user.id) || [];
    const enriched = watches.map(w => {
      const raw = GpuRepository.getById(w.gpuId);
      // apiKey・providerId など機密/内部フィールドを除外し、表示に必要な公開フィールドのみ返す
      const gpu = raw ? {
        id: raw.id,
        name: raw.name,
        model: raw.model,
        vendor: raw.vendor,
        memoryGB: raw.memoryGB,
        pricePerHour: raw.pricePerHour,
        // マーケットプレイスの rentable 述語は available !== false（undefined は rentable 扱い）。
        // API クライアントがこの内部規約を知らずに available === true で判定すると
        // 未設定 GPU を全部「借りられない」と誤判定する。スナップショットでは
        // 明示的な boolean に正規化して呼び出し側の誤判定リスクを排除する。
        available: raw.available !== false,
      } : null;
      return { ...w, gpu };
    });
    return res.json({ watches: enriched });
  })
);


module.exports = router;
