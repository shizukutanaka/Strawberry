// src/api/middleware/master-session.js
// master-auth（Google OAuth→TOTP→メール の3段階認証）用セッションミドルウェアの
// 単一共有インスタンス。
//
// このモジュールは express-session の session(...) 呼び出しを一度だけ行い、
// require キャッシュにより同一インスタンス（同一 MemoryStore）を全 import 元へ
// 配布する。master-auth.js の /master-auth/* ルートと、requireMasterAuth を
// 適用する他ルート（例: profit-addresses.js）が別々に session(...) を呼ぶと、
// それぞれが独立した MemoryStore を持ってしまい、同じセッション Cookie でも
// 互いの req.session を参照できない（片方で masterAuth=true にしても
// もう片方では未認証のまま）。このモジュールを両方から require することで
// req.session が同一ストアを参照し、3段階認証の完了状態を他ルートでも
// 正しく検証できるようにする。
const session = require('express-session');
const { requireSecret } = require('../../utils/config');

const masterSession = session({
  secret: requireSecret('SESSION_SECRET'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
    // path 未指定 = デフォルト '/' 全パスに Cookie を送信するため、
    // /master-auth/* で確立したセッションを他パスのルートからも参照できる。
  }
});

module.exports = { masterSession };
