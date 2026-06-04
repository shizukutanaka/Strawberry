// AES暗号化・復号化ユーティリティ
const crypto = require('crypto');
const { requireSecret } = require('../utils/config');

// ハードコードされたデフォルト鍵を廃止。ENCRYPTION_KEY を必須化し、
// sha256 で常に 32byte 鍵へ正規化する(aes-256-cbc 用)。
const KEY = crypto.createHash('sha256').update(requireSecret('ENCRYPTION_KEY')).digest();
const IV_LENGTH = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(KEY), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  const [ivHex, encrypted] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(KEY), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
