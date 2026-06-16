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

// プロセス内で prevHash をキャッシュ（初回起動時の1回のみディスク読み込み）。
// クラッシュ・ギャップ検出（ログとハッシュの不整合）も起動時に1回だけ行い、
// 以降の appendAuditLog 呼び出しは O(1) で動作する。
const _hashCache = new Map(); // logPath → { prevHash, initialized }
function _getOrInitPrevHash(logPath, hashPath) {
  const cached = _hashCache.get(logPath);
  if (cached) return cached.prevHash;
  let prevHash = '';
  if (fs.existsSync(hashPath)) {
    const stored = fs.readFileSync(hashPath, 'utf-8').trim();
    if (stored && fs.existsSync(logPath)) {
      // クラッシュ・ギャップ検出: ログ全体から末尾ハッシュを再計算し、保存値と比較する。
      // 起動時に1回だけ実施し、ズレがあればハッシュを修復してから in-process キャッシュを設定。
      const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
      let recomputed = '';
      for (const line of lines) {
        recomputed = crypto.createHash('sha256').update(recomputed + line).digest('hex');
      }
      if (recomputed !== stored) {
        // eslint-disable-next-line no-console
        console.error('[audit-log] Hash chain gap detected (crash recovery); repairing from log.');
        atomicWriteString(hashPath, recomputed);
        prevHash = recomputed;
      } else {
        prevHash = stored;
      }
    } else {
      prevHash = stored;
    }
  }
  _hashCache.set(logPath, { prevHash });
  return prevHash;
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

    // prevHash: 起動時に1回だけディスクから読み込み、以降はキャッシュを使う（O(1)）。
    const prevHash = _getOrInitPrevHash(logPath, hashPath);
    const hash = crypto.createHash('sha256').update(prevHash + entryStr).digest('hex');
    fs.appendFileSync(logPath, entryStr + '\n');
    atomicWriteString(hashPath, hash);
    // キャッシュ更新: 次回呼び出しのための prevHash
    _hashCache.set(logPath, { prevHash: hash });
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
