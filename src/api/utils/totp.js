// TOTP（Google Authenticator等互換）ユーティリティ
const speakeasy = require('speakeasy');


function verifyTOTP(secret, token) {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 1
  });
}

module.exports = { verifyTOTP };
