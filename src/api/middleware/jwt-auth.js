// JWT認証ミドルウェア雛形
const jwt = require('jsonwebtoken');
// 署名(src/api/routes/user/index.js)と同じシークレットを使用。
// ハードコードされたフォールバックは廃止し、config.requireSecret() に一元化。
const { config } = require('../../utils/config');
const SECRET = config.security.jwtSecret;

module.exports = function(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '認証トークンがありません' });
  }
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: '無効なトークン' });
  }
};
