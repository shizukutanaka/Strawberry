// 監査ログ自動記録・改ざん検知ユーティリティ
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteString } = require('../db/json/atomicWrite');

const LOGS_DIR = path.join(__dirname, '../../logs');
const AUDIT_LOG_PATH = path.join(LOGS_DIR, 'audit.log');
const HASH_CHAIN_PATH = path.join(LOGS_DIR, 'audit.hash');

// ディレクトリが存在しない場合に作成（起動時・テスト時の ENOENT を防ぐ）
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (_) {}

/**
 * 監査ログを追記し、改ざん検知用ハッシュチェーンを自動生成。
 * I/O エラーは呼び出し元に伝播させない。監査ログの書き込み失敗が
 * 業務レスポンス（決済・部分決済通知など）をマスクしてはならないため。
 */
function appendAuditLog(action, detail = {}, user = 'system') {
  try {
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
    atomicWriteString(HASH_CHAIN_PATH, hash);
  } catch (e) {
    // 監査ログ書き込み失敗はサイレントに記録し、呼び出し元をクラッシュさせない
    // eslint-disable-next-line no-console
    console.error('[audit-log] Failed to write audit entry:', action, e && e.message);
  }
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
