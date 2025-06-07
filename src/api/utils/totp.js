// TOTP（Google Authenticator等互換）ユーティリティ
const speakeasy = require('speakeasy');

function generateTOTP(secret) {
  return speakeasy.totp({
    secret,
    encoding: 'base32',
    digits: 6,
    step: 30
  });
}

function verifyTOTP(secret, token) {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 1
  });
}

module.exports = { generateTOTP, verifyTOTP };
