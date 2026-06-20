// 為替レート・キャッシュ・取得時刻を返すREST APIルート
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { getBTCtoJPYRate } = require('../../utils/exchange-rate');

// 未認証エンドポイントなので独自レート制限を必ず掛ける。
// 旧実装はグローバル apiLimiter より前にマウントされていたため
// `?fresh=true` でキャッシュをバイパスして最大 4 つの外部 HTTP を
// 1 リクエストあたり起こす SSRF 増幅 / 上流レートリミット消費 DoS が成立していた。
const _erLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: () => process.env.NODE_ENV === 'test' ? 10000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/exchange-rate
router.get('/', _erLimiter, async (req, res) => {
  try {
    // ?fresh=true は管理者のみ。匿名ユーザーが繰り返しキャッシュを無視させると、
    // 1 リクエストあたり最大 4 つの外部 HTTPS 呼び出しを誘発でき上流プロバイダの
    // レートリミットを消費して全注文の価格計算を壊せる。
    let forceFresh = false;
    if (req.query.fresh === 'true') {
      const authHeader = req.headers.authorization || '';
      if (authHeader.startsWith('Bearer ')) {
        try {
          const jwt = require('jsonwebtoken');
          const { resolveSecret } = require('../middleware/jwt-auth');
          const decoded = jwt.verify(authHeader.slice(7), resolveSecret(), { algorithms: ['HS256'] });
          // 失効済み・セッション無効化済みトークンは fresh=true を拒否。
          // ログアウト・ロール降格後のトークンで上流レート制限を消費できてしまうのを防ぐ。
          if (decoded && decoded.role === 'admin') {
            const { isRevoked } = require('../middleware/token-denylist');
            const { isSessionInvalidated } = require('../utils/session-invalidation');
            const UserRepository = require('../../db/json/UserRepository');
            const u = UserRepository.getById(decoded.id);
            const revoked = decoded.jti && isRevoked(decoded.jti);
            const invalidated = !u || u.status === 'deactivated' || isSessionInvalidated(u, decoded.iat);
            if (!revoked && !invalidated) forceFresh = true;
          }
        } catch (_) { /* invalid token → forceFresh remains false */ }
      }
    }
    const { rate, timestamp, isCache } = await getBTCtoJPYRate(forceFresh, true);
    res.json({
      rate,
      timestamp,
      isCache: !!isCache
    });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Failed to fetch exchange rate' : err.message });
  }
});

module.exports = router;
