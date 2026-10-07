// JWT認証ミドルウェア雛形
const jwt = require('jsonwebtoken');
// 署名(src/api/routes/user/index.js)と同じシークレットを使用。
// ハードコードされたフォールバックは廃止し、config.requireSecret() に一元化。
// シークレットは「リクエスト時」に解決する（モジュール読込時に固定すると鍵ローテーション
// 不可・テスト不能になり、security.js の authenticateJWT と挙動が食い違うため）。
const { config } = require('../../utils/config');
// logout で失効済みのトークン(jti)を拒否する
const { isRevoked } = require('./token-denylist');

function resolveSecret() {
  // 明示的に設定された JWT_SECRET を優先し、無ければ config の解決値にフォールバック
  return process.env.JWT_SECRET || config.security.jwtSecret;
}

// Refresh tokens use a separate secret when JWT_REFRESH_SECRET is set.
// This prevents cross-type substitution: a stolen refresh token cannot be used
// as an access token even if the type check is skipped somewhere.
// Falls back to the access-token secret for backward compatibility with
// deployments that have not configured a separate refresh secret.
function resolveRefreshSecret() {
  return process.env.JWT_REFRESH_SECRET || resolveSecret();
}

// 鍵ローテーション猶予（弱所#15）: 新シークレットへ更新する際、旧シークレットを
// JWT_SECRET_PREVIOUS（アクセス用）/ JWT_REFRESH_SECRET_PREVIOUS（リフレッシュ用）に
// カンマ区切りで置けば、猶予期間中は旧鍵署名のトークンも検証を通る。
// アクセストークン TTL(1h)+リフレッシュ TTL(7d) だけ残し、全トークンが新鍵へ
// 移行したら除去する。アクセス/リフレッシュで別リストにするのは、古いアクセス鍵を
// 知る攻撃者がリフレッシュトークンを偽造できないようにするため。
function _previousSecrets(envName) {
  const raw = process.env[envName];
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// 現行鍵を先に試し、失敗したら旧鍵リストを順に試す。payload を返すか、
// 全鍵で失敗したら最後のエラーを投げる（呼出側の従来挙動と同じ）。
// 署名アルゴリズムは HS256 固定 — 旧鍵でも alg=none / RS256 すり替えは通らない。
// refresh で JWT_REFRESH_SECRET 未設定（アクセス鍵と共用）の場合は、旧鍵
// リストも JWT_SECRET_PREVIOUS を踏襲する — 共用鍵ローテーション時に
// リフレッシュトークンだけが切り捨てられないようにするため。
function verifyWithRotation(token, { refresh = false } = {}) {
  const hasDedicatedRefresh = !!process.env.JWT_REFRESH_SECRET;
  const primary = refresh ? resolveRefreshSecret() : resolveSecret();
  const previousEnv = refresh && hasDedicatedRefresh
    ? 'JWT_REFRESH_SECRET_PREVIOUS'
    : 'JWT_SECRET_PREVIOUS';
  const previous = _previousSecrets(previousEnv);
  let lastErr;
  for (const secret of [primary, ...previous]) {
    try {
      return jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

module.exports = function(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '認証トークンがありません' });
  }
  const token = auth.slice(7);
  try {
    // algorithms を固定し、アルゴリズム混同攻撃（alg=none / RS256 すり替え）を防ぐ（署名は HS256）。
    const payload = verifyWithRotation(token);
    // リフレッシュトークンをアクセストークンとして使わせない（type 厳密分離）。
    // type 無しトークンは旧アクセストークンとして許可（後方互換）。
    if (payload.type === 'refresh') {
      return res.status(401).json({ error: '無効なトークン' });
    }
    if (payload.jti && isRevoked(payload.jti)) {
      return res.status(401).json({ error: '無効なトークン' });
    }
    // パスワード変更・全セッション失効（リフレッシュ再利用検知等）後のトークンを拒否
    // （security.js / GraphQL / refresh と同一ポリシーを共有ヘルパーに集約）。
    // リクエスト毎の users.json 全量読み込みを避けるため stat ゲートの
    // 認証専用キャッシュ経由でルックアップする。
    const { getAuthUser } = require('../utils/auth-user-lookup');
    const tokenUser = getAuthUser(payload.id);
    if (!tokenUser || tokenUser.status === 'deactivated') {
      return res.status(401).json({ error: '無効なトークン' });
    }
    const { isSessionInvalidated } = require('../utils/session-invalidation');
    if (isSessionInvalidated(tokenUser, payload.iat)) {
      return res.status(401).json({ error: '無効なトークン' });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: '無効なトークン' });
  }
};

module.exports.resolveSecret = resolveSecret;
module.exports.resolveRefreshSecret = resolveRefreshSecret;
module.exports.verifyWithRotation = verifyWithRotation;
