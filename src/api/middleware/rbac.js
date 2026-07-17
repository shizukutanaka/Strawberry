// RBAC（ロールベース認可）ミドルウェア
const { APIError, ErrorTypes } = require('../../utils/error-handler');

module.exports = function(requiredRole) {
  return function(req, res, next) {
    const user = req.user;
    if (!user || !user.role) {
      return next(new APIError(ErrorTypes.UNAUTHORIZED, '認証情報がありません', 401));
    }
    // JWTペイロードの role が文字列以外（配列・オブジェクト等）だった場合は
    // 型混同によるバイパスを防ぐため明示的に拒否する。
    if (typeof user.role !== 'string') {
      return next(new APIError(ErrorTypes.FORBIDDEN, '権限がありません', 403));
    }
    if (Array.isArray(requiredRole)) {
      if (!requiredRole.includes(user.role)) {
        return next(new APIError(ErrorTypes.FORBIDDEN, '権限がありません', 403));
      }
    } else {
      if (user.role !== requiredRole) {
        return next(new APIError(ErrorTypes.FORBIDDEN, '権限がありません', 403));
      }
    }
    next();
  };
};
