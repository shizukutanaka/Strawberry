// 監査ログ自動記録・改ざん検知ユーティリティ
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteString } = require('../db/json/atomicWrite');

const DEFAULT_LOG_PATH = path.join(__dirname, '../../logs/audit.log');

// ログ/ハッシュのパスは呼び出し時に解決する。AUDIT_LOG_PATH を設定すると差し替え可能で、
// テストが各自の隔離ファイルを使えるため、並列実行時に共有 audit.log を汚染し合って
// ハッシュチェーン検証が壊れる問題を避けられる。ハッシュは既定でログの隣に .hash で置く。
function auditLogPath() {
  return process.env.AUDIT_LOG_PATH || DEFAULT_LOG_PATH;
}
function hashChainPath() {
  if (process.env.AUDIT_HASH_PATH) return process.env.AUDIT_HASH_PATH;
  const log = auditLogPath();
  return log.endsWith('.log') ? `${log.slice(0, -4)}.hash` : `${log}.hash`;
}

/**
 * 監査ログを追記し、改ざん検知用ハッシュチェーンを自動生成。
 * I/O エラーは呼び出し元に伝播させない。監査ログの書き込み失敗が
 * 業務レスポンス（決済・部分決済通知など）をマスクしてはならないため。
 */
function appendAuditLog(action, detail = {}, user = 'system') {
  try {
    const logPath = auditLogPath();
    const hashPath = hashChainPath();
    // ディレクトリが存在しない場合に作成（起動時・テスト時の ENOENT を防ぐ）
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (_) {}
    const timestamp = new Date().toISOString();
    const entry = { timestamp, action, detail, user };
    const entryStr = JSON.stringify(entry);
    fs.appendFileSync(logPath, entryStr + '\n');
    // 改ざん検知用ハッシュチェーン
    let prevHash = '';
    if (fs.existsSync(hashPath)) {
      prevHash = fs.readFileSync(hashPath, 'utf-8').trim();
    }
    const hash = crypto.createHash('sha256').update(prevHash + entryStr).digest('hex');
    atomicWriteString(hashPath, hash);
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
  const logPath = auditLogPath();
  const hashPath = hashChainPath();
  if (!fs.existsSync(logPath) || !fs.existsSync(hashPath)) return false;
  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  let prevHash = '';
  for (const line of lines) {
    const hash = crypto.createHash('sha256').update(prevHash + line).digest('hex');
    prevHash = hash;
  }
  const lastHash = fs.readFileSync(hashPath, 'utf-8').trim();
  return prevHash === lastHash;
}

module.exports = { appendAuditLog, verifyAuditLogIntegrity };
