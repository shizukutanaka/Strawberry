// RBAC（ロールベース認可）ミドルウェア雛形
module.exports = function(requiredRole) {
  return function(req, res, next) {
    const user = req.user;
    if (!user || !user.role) {
      return res.status(401).json({ error: '認証情報がありません' });
    }
    if (Array.isArray(requiredRole)) {
      if (!requiredRole.includes(user.role)) {
        return res.status(403).json({ error: '権限がありません' });
      }
    } else {
      if (user.role !== requiredRole) {
        return res.status(403).json({ error: '権限がありません' });
      }
    }
    next();
  };
};
