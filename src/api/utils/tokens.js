// src/api/utils/tokens.js - アクセストークン/リフレッシュトークン発行ヘルパー
// 短命アクセストークン + 長命リフレッシュトークンの2トークン構成。
// type フィールドで厳密に区別し、リフレッシュトークンをアクセストークンとして
// 使えないようにする（jwt-auth/security の検証側で type:'refresh' を拒否）。
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { config } = require('../../utils/config');
const { resolveSecret, resolveRefreshSecret } = require('../middleware/jwt-auth');

// TTL は呼出し毎に env を解決（テスト・運用での動的変更に対応）
const accessTTL = () => process.env.JWT_EXPIRES_IN || config.security.jwtExpiresIn || '1h';
const refreshTTL = () => process.env.JWT_REFRESH_EXPIRES_IN || config.security.jwtRefreshExpiresIn || '7d';

// jti may be supplied by caller so the refresh token can embed ati (access token id)
// and revoke the prior access token when the refresh token is consumed.
function signAccessToken(user, jti = uuidv4()) {
  return jwt.sign(
    { id: user.id, role: user.role, type: 'access', jti },
    resolveSecret(),
    { expiresIn: accessTTL() }
  );
}

// ati: the jti of the access token issued alongside this refresh token.
// Stored so the /refresh endpoint can revoke the paired access token on rotation,
// preventing a stolen access token from outliving the refresh-token rotation.
function signRefreshToken(user, ati) {
  const payload = { id: user.id, role: user.role, type: 'refresh', jti: uuidv4() };
  if (ati) payload.ati = ati;
  return jwt.sign(payload, resolveRefreshSecret(), { expiresIn: refreshTTL() });
}

module.exports = { signAccessToken, signRefreshToken, accessTTL, refreshTTL };
