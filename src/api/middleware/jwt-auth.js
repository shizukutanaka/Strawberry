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

module.exports = function(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '認証トークンがありません' });
  }
  const token = auth.slice(7);
  try {
    // algorithms を固定し、アルゴリズム混同攻撃（alg=none / RS256 すり替え）を防ぐ（署名は HS256）。
    const payload = jwt.verify(token, resolveSecret(), { algorithms: ['HS256'] });
    if (payload.jti && isRevoked(payload.jti)) {
      return res.status(401).json({ error: '無効なトークン' });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: '無効なトークン' });
  }
};

module.exports.resolveSecret = resolveSecret;
