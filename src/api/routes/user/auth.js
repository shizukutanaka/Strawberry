// src/api/routes/user/auth.js - 認証系エンドポイント
// （register・login・refresh・logout — ログイン失敗ロック・タイミング均一化を含む）。
const express = require('express');
const router = express.Router();

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT } = require('../../middleware/security');
const { config } = require('../../../utils/config');
const { resolveRefreshSecret } = require('../../middleware/jwt-auth');
const { withLock } = require('../../../utils/async-lock');
const { sanitizeObject } = require('../../../utils/sanitize');
const { sanitizeUser } = require('../../utils/sanitize-user');
const { authLimiter } = require('../../middleware/rate-limit');
const { isSessionInvalidated } = require('../../utils/session-invalidation');
const { isRevoked, revoke } = require('../../middleware/token-denylist');
const { signAccessToken, signRefreshToken } = require('../../utils/tokens');
const UserRepository = require('../../../db/json/UserRepository');

// Generated once at startup so the cost is paid upfront, not on first login attempt.
//
// 重要: コストファクタは必ず本物のパスワードハッシュと同じ config.security.bcryptRounds を
// 使う。ここを定数（例: 10）で固定すると、運用者が BCRYPT_ROUNDS を 12 等に引き上げた
// 瞬間に「実在ユーザー = cost 12（遅い）」「不在ユーザー = ダミー cost 10（速い）」の
// タイミング差が生じ、ダミーハッシュ本来の目的（アカウント列挙のタイミング遮断）が
// 静かに破れる。両者のコストを常に一致させることでこの再発リスクを断つ。
const _DUMMY_HASH = bcrypt.hashSync('strawberry-timing-guard', config.security.bcryptRounds);

// アカウント単位のブルートフォース抑制（IPを迂回した辞書攻撃対策）。
// スライディングウィンドウ: 15分以内に10回失敗 → 429。成功でリセット。
const _loginFailures = new Map(); // email → { count, windowStart }
const _LOGIN_WINDOW_MS = 15 * 60 * 1000;
const _LOGIN_MAX_FAILURES = 10;
function _recordLoginFailure(email) {
  const now = Date.now();
  const entry = _loginFailures.get(email) || { count: 0, windowStart: now };
  if (now - entry.windowStart > _LOGIN_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  _loginFailures.set(email, entry);
  return entry.count;
}
function _resetLoginFailures(email) { _loginFailures.delete(email); }
function _isLoginLocked(email) {
  const entry = _loginFailures.get(email);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > _LOGIN_WINDOW_MS) { _loginFailures.delete(email); return false; }
  return entry.count >= _LOGIN_MAX_FAILURES;
}

// ユーザー登録

router.post('/register',
  authLimiter,
  validateMiddleware(schemas.user.register),
  asyncHandler(async (req, res) => {
    // 入力値サニタイズ
    const sanitized = sanitizeObject(req.validatedBody, ['username', 'email']);
    // メールアドレスは大文字小文字を区別しない（RFC 5321 では local-part は区別されるが
    // 実運用上ほぼ全プロバイダが等価扱い）。正規化しないと USER@X.COM と user@x.com が
    // 別アカウントとして登録でき、同一受信箱へのなりすましや混乱が生じる。
    const { username, password, role } = sanitized;
    const email = typeof sanitized.email === 'string' ? sanitized.email.toLowerCase() : sanitized.email;
    // 自己登録では 'user' または 'provider' のみ許可（admin への昇格は管理者が行う）
    const assignedRole = (role === 'provider') ? 'provider' : 'user';
    logger.info(`Registering new user: ${username}`);
    // bcrypt はロック外で先に計算（重い演算をロック保持中に行わないため）。
    // ロック内で重複チェック＋作成を不可分に実行し、同一メール同時登録 TOCTOU を閉じる。
    const salt = await bcrypt.genSalt(config.security.bcryptRounds);
    const hashedPassword = await bcrypt.hash(password, salt);
    let newUser;
    const registerConflict = await withLock(`register:${email}`, async () => {
      if (UserRepository.getByEmail(email)) return 'email';
      if (UserRepository.getByUsername(username)) return 'username';
      newUser = UserRepository.create({
        username,
        email,
        password: hashedPassword,
        role: assignedRole,
        lastLogin: null,
      });
      return null;
    });
    if (registerConflict === 'email') return res.status(409).json({ error: 'Email already registered' });
    if (registerConflict === 'username') return res.status(409).json({ error: 'Username already taken' });
    // ユーザー登録をログに記録（既存バグ: 未定義の userId を参照し登録毎にクラッシュしていた）
    logger.info(`User registered: ${newUser.id}`, {
      userId: newUser.id,
      username,
      role: newUser.role
    });
    // Use sanitizeUser() to strip password, apiKey, jti, and any other secret fields.
    // The previous manual `delete password` left apiKey in the response body.
    res.status(201).json({
      message: 'User registered successfully',
      user: sanitizeUser(newUser)
    });
  })
);

// ログイン

router.post('/login',
  authLimiter,
  validateMiddleware(schemas.user.login),
  asyncHandler(async (req, res) => {
    const { password } = req.validatedBody;
    const email = typeof req.validatedBody.email === 'string' ? req.validatedBody.email.toLowerCase() : req.validatedBody.email;
    logger.info(`Login attempt: ${email}`);
    // アカウント単位ロックアウト（IPを迂回した辞書攻撃対策）
    if (_isLoginLocked(email)) {
      return res.status(429).json({ error: 'Too many failed login attempts. Please try again later.' });
    }
    // ユーザーを検索（永続化対応）
    const user = UserRepository.getByEmail(email);
    // Always run bcrypt.compare even when user is not found to prevent
    // account enumeration via timing: without this, non-existent emails
    // return in ~1ms vs ~100ms for wrong passwords, leaking email validity.
    const hashToCompare = (user && user.password) || _DUMMY_HASH;
    const validPassword = await bcrypt.compare(password, hashToCompare);
    if (!user || !validPassword) {
      // ログメッセージを統一して「ユーザー不在」と「誤パスワード」を区別しない。
      // ログ閲覧権限を持つオペレータによるメールアドレス列挙を防ぐ。
      logger.warn(`Login failed (${email})`);
      _recordLoginFailure(email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // 無効化済みアカウントはログイン不可（メール匿名化に加えた多層防御）
    if (user.status === 'deactivated') {
      logger.warn(`Login failed: account deactivated (${email})`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // ログイン成功 → 失敗カウントをリセット
    _resetLoginFailures(email);
    // アクセストークン（短命）+ リフレッシュトークン（長命）を発行。
    // jti は logout 時の失効に使用。type で両者を厳密分離。
    const accessJti = uuidv4();
    const token = signAccessToken(user, accessJti);
    const refreshToken = signRefreshToken(user, accessJti);
    UserRepository.update(user.id, { lastLogin: new Date().toISOString() });
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
      payload = jwt.verify(refreshToken, resolveRefreshSecret(), { algorithms: ['HS256'] });
    } catch (_) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    // リフレッシュトークン以外（アクセストークン等）では更新不可
    if (payload.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    // jti がないリフレッシュトークンは single-use 強制・再利用検知が機能しない（fix probe 35）。
    // 正規発行トークンは必ず jti を持つ（signRefreshToken → uuidv4）。
    // jti なしトークンは手動署名か旧バージョン発行の可能性が高く、永続的に再利用できてしまう。
    if (!payload.jti) {
      return res.status(401).json({ error: 'Invalid refresh token: missing token identifier' });
    }
    // ユーザーが削除/無効化されていないか確認（最新のロールも反映）
    const user = UserRepository.getById(payload.id);
    if (!user || user.status === 'deactivated') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    // jti ごとにロックし、check→revoke→reissue をアトミックにする。
    // ロックがないと 2 つの並行リクエストが両方 isRevoked(jti)=false を見てから
    // それぞれ revoke を呼び、どちらも新しいトークンペアを返す（single-use 破り）。
    // reuse-detection は次のアクセスで機能するが、攻撃者が先行して rotate した
    // 連鎖チェーンは生き残り得る。/register や /me/settings と同じパターン。
    const lockKey = `refresh:${payload.jti}`; // jti is guaranteed non-null (checked above)
    return withLock(lockKey, async () => {
    // リフレッシュトークン再利用検知（盗難シグナル）:
    // 既に失効済み(= logout または rotation で消費済み)の jti が再提示された場合、
    // 単にこの 1 トークンを 401 で弾くだけでは不十分。rotation で「先に進んだ」攻撃者
    // (または被害者)が保持する新しいリフレッシュトークンは生き残ってしまう。OWASP 推奨に
    // 従い、再利用検知時は当該ユーザーの *全* セッションを失効させ(sessionsRevokedAt を更新)、
    // 攻撃者の連鎖トークンも含めて全て無効化して再ログインを強制する。
    if (payload.jti && isRevoked(payload.jti)) {
      try {
        UserRepository.update(user.id, { sessionsRevokedAt: new Date().toISOString() });
        logger.warn(`Refresh token reuse detected for user ${user.id}; all sessions revoked`);
      } catch (e) {
        logger.error(`Failed to revoke sessions on refresh reuse (user=${user.id}): ${e.message}`);
      }
      return res.status(401).json({ error: 'Refresh token reuse detected; all sessions have been revoked. Please log in again.' });
    }
    // パスワード変更・全セッション失効より後に発行されたリフレッシュトークンのみ受け付ける
    // （共有ヘルパーで REST 全ルートと同一ポリシー）。盗まれたトークンはこれらで無効化できる。
    if (isSessionInvalidated(user, payload.iat)) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    // 使い切り（single-use）: 使用済みリフレッシュトークンの jti を失効させることで
    // 同じトークンを再利用したリプレイアタックを防ぐ。
    // jti は上で必須チェック済みのため条件分岐不要。
    revoke(payload.jti, payload.exp ? payload.exp * 1000 : Date.now() + 24 * 60 * 60 * 1000);
    // ati: refresh token 発行時にペアだったアクセストークンの jti を失効させる。
    // これにより、盗難されたアクセストークンが rotation 後も生き続けるのを防ぐ。
    if (payload.ati) {
      revoke(payload.ati, Date.now() + 60 * 60 * 1000);
    }
    const newAccessJti = uuidv4();
    const token = signAccessToken(user, newAccessJti);
    const newRefreshToken = signRefreshToken(user, newAccessJti);
    logger.info(`Access token refreshed for user: ${user.id}`);
    res.json({ message: 'Token refreshed', token, refreshToken: newRefreshToken });
    }); // end withLock(refresh)
  })
);

// ログアウト（トークン失効。認証必須）

router.post('/logout',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (refreshToken && typeof refreshToken === 'string') {
      // リフレッシュトークンが提供されていれば jti を即時失効させる。
      try {
        const rp = jwt.verify(refreshToken, resolveRefreshSecret(), { algorithms: ['HS256'] });
        if (rp.type === 'refresh' && rp.jti) {
          revoke(rp.jti, rp.exp ? rp.exp * 1000 : Date.now() + 24 * 60 * 60 * 1000);
        }
      } catch (_) { /* 無効なリフレッシュトークンは無視（logout は冪等に成功させる） */ }
    } else {
      // リフレッシュトークンが提供されなかった場合: クライアントが意図的に省略した場合や
      // リフレッシュトークンを保持していない場合でも、sessionsRevokedAt を更新することで
      // 既存の全リフレッシュトークンを無効化し、盗難トークンによるポストログアウト利用を防ぐ。
      // トレードオフ: 他デバイスのセッションも同時に失効する（"log out everywhere" 動作）。
      try {
        UserRepository.update(req.user.id, { sessionsRevokedAt: new Date().toISOString() });
      } catch (_) { /* 更新失敗はログアウト自体を妨げない */ }
    }
    if (req.user.jti) {
      // exp（秒）をミリ秒に変換して保持期限とする。それ以降は自然失効するため保持不要。
      revoke(req.user.jti, req.user.exp ? req.user.exp * 1000 : Date.now() + 24 * 60 * 60 * 1000);
      logger.info(`User logged out (token revoked): ${req.user.id}`);
      return res.json({ message: 'Logged out successfully' });
    }
    // jti の無い旧トークンは失効リストに載せられない（exp までは有効なまま）
    res.json({ message: 'Logged out (token issued before revocation support; it will expire naturally)' });
  })
);

// 現在のユーザー情報取得 (認証必須)

module.exports = router;
