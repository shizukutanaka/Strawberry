// AES暗号化・復号化ユーティリティ
const crypto = require('crypto');
const { requireSecret } = require('../utils/config');

// ハードコードされたデフォルト鍵を廃止。ENCRYPTION_KEY を必須化し、
// sha256 で常に 32byte 鍵へ正規化する (aes-256-gcm 用)。
const KEY = crypto.createHash('sha256').update(requireSecret('ENCRYPTION_KEY')).digest();

// AES-256-GCM (AEAD): CBC の問題点だったパディングオラクルと IV 改ざん（CBC bit-flip）を
// 認証タグで排除する。タグ検証失敗時は decipher.final() が例外を投げるため
// 改ざん検知が自動的に保証される。
// 出力フォーマット: <12-byte IV hex>:<16-byte auth tag hex>:<ciphertext hex>
function encrypt(text) {
  const iv = crypto.randomBytes(12); // GCM 推奨 96-bit IV
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(text) {
  const parts = text.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext format');
  const [ivHex, tagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag); // 改ざん時は final() で AuthTagMismatch を投げる
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt };
