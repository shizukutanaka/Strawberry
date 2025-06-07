// 監査ログ自動記録・改ざん検知ユーティリティ
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIT_LOG_PATH = path.join(__dirname, '../../logs/audit.log');
const HASH_CHAIN_PATH = path.join(__dirname, '../../logs/audit.hash');

/**
 * 監査ログを追記し、改ざん検知用ハッシュチェーンを自動生成
 * @param {string} action - 操作種別
 * @param {object} detail - 詳細情報
 * @param {string} [user] - 操作者
 */
function appendAuditLog(action, detail = {}, user = 'system') {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, action, detail, user };
  const entryStr = JSON.stringify(entry);
  fs.appendFileSync(AUDIT_LOG_PATH, entryStr + '\n');
  // 改ざん検知用ハッシュチェーン
  let prevHash = '';
  if (fs.existsSync(HASH_CHAIN_PATH)) {
    prevHash = fs.readFileSync(HASH_CHAIN_PATH, 'utf-8').trim();
  }
  const hash = crypto.createHash('sha256').update(prevHash + entryStr).digest('hex');
  fs.writeFileSync(HASH_CHAIN_PATH, hash);
}

/**
 * 監査ログの改ざん検証
 * @returns {boolean}
 */
function verifyAuditLogIntegrity() {
  if (!fs.existsSync(AUDIT_LOG_PATH) || !fs.existsSync(HASH_CHAIN_PATH)) return false;
  const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf-8').split('\n').filter(Boolean);
  let prevHash = '';
  for (const line of lines) {
    const hash = crypto.createHash('sha256').update(prevHash + line).digest('hex');
    prevHash = hash;
  }
  const lastHash = fs.readFileSync(HASH_CHAIN_PATH, 'utf-8').trim();
  return prevHash === lastHash;
}

module.exports = { appendAuditLog, verifyAuditLogIntegrity };
