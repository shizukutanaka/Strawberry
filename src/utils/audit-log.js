// 監査ログ自動記録・改ざん検知ユーティリティ
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteString } = require('../db/json/atomicWrite');

const DEFAULT_LOG_PATH = path.join(__dirname, '../../logs/audit.log');

// ディスク枯渇防止: ログファイルがこのサイズを超えたら新規エントリを拒否し警告を出す。
// 認証済みユーザーが監査対象アクション（異常検知・webhook 失敗等）を連打することで
// ディスクをフルにし、audit.log のサイレント失敗と引き換えにサービス全体を落とせる。
const MAX_AUDIT_LOG_BYTES = (process.env.MAX_AUDIT_LOG_MB
  ? parseInt(process.env.MAX_AUDIT_LOG_MB, 10) : 50) * 1024 * 1024;

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
        // 旧実装は保存ハッシュと再計算ハッシュが食い違ったときに無条件で
        // 再計算ハッシュ側で .hash を書き換えていた。これはログを直接改ざんできる
        // 攻撃者（コンテナ内 RCE / log volume の sidecar / 共有ボリューム経由）が
        // 偽の audit エントリを書き込んでサーバを再起動するだけで「正規のチェーン」に
        // 取り込ませる self-heal バックドアになる。
        // 既定では起動失敗にし、運用者が手動レビュー後に AUDIT_LOG_FORCE_REPAIR=1 を
        // 明示設定したときだけ修復を許可する。テスト時は従来通り自動修復（テスト分離のため）。
        const msg = `[audit-log] Hash chain mismatch (log tampered or crashed). ` +
                    `stored=${stored.slice(0, 16)}... recomputed=${recomputed.slice(0, 16)}...`;
        if (process.env.NODE_ENV !== 'test' && process.env.AUDIT_LOG_FORCE_REPAIR !== '1') {
          throw new Error(`${msg} Set AUDIT_LOG_FORCE_REPAIR=1 after manual review to allow self-repair.`);
        }
            console.error(`${msg} Repair allowed (test mode or AUDIT_LOG_FORCE_REPAIR=1).`);
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
  // catch 側で隔離に使うため try の外で組み立てる（try 内で宣言すると
  // 書き込み失敗時にエントリ本体が参照できず、記録を丸ごと失う）。
  const entryStr = JSON.stringify({ timestamp: new Date().toISOString(), action, detail, user });
  try {
    const logPath = auditLogPath();
    const hashPath = hashChainPath();
    // ディレクトリが存在しない場合に作成（起動時・テスト時の ENOENT を防ぐ）
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (_) {}

    // prevHash: 起動時に1回だけディスクから読み込み、以降はキャッシュを使う（O(1)）。
    const prevHash = _getOrInitPrevHash(logPath, hashPath);
    const hash = crypto.createHash('sha256').update(prevHash + entryStr).digest('hex');
    // ディスク枯渇防止: ファイルサイズが上限を超えていたら書き込みをスキップして警告。
    // ENOSPC で例外が飛んでもサイレントに飲み込むと監査証跡がダークになるため、
    // 上限手前で先んじてアラートを出し、運用者が対処できるようにする。
    try {
      const stat = fs.statSync(logPath);
      if (stat.size >= MAX_AUDIT_LOG_BYTES) {
        _recordFailure(action,
          `audit log reached its size limit (${Math.round(stat.size / 1024 / 1024)}MB >= ${MAX_AUDIT_LOG_BYTES / 1024 / 1024}MB)`,
          'size_limit');
        _quarantine(entryStr, 'size_limit');
        return;
      }
    } catch (_statErr) { /* file may not exist yet — that's fine */ }
    fs.appendFileSync(logPath, entryStr + '\n');
    atomicWriteString(hashPath, hash);
    // キャッシュ更新: 次回呼び出しのための prevHash
    _hashCache.set(logPath, { prevHash: hash });
  } catch (e) {
    // 監査ログ書き込み失敗で呼び出し元をクラッシュさせないのは従来どおり。
    // ただし**黙って消さない**。以前はここが console.error だけで、
    //   - ハッシュチェーンが壊れると以降**すべての**エントリが書けなくなる
    //   - それでもアプリは平常どおり動き続ける
    //   - 唯一の痕跡は誰も見ない標準エラー出力
    // という状態だった。非否認性のために監査ログを持ち、その root を外部へ
    // アンカーしている製品で、記録が静かに止まるのは最悪の壊れ方にあたる
    // （アンカラーは伸びない末尾をアンカーし続けるので、外から見ると健全に映る）。
    const isEnospc = e && (e.code === 'ENOSPC' || (e.message && e.message.includes('ENOSPC')));
    _recordFailure(action, e && e.message, isEnospc ? 'disk_full' : 'write_failed');
    _quarantine(entryStr, e && e.message);
  }
}

// ── 書き込み失敗の可視化 ────────────────────────────────────────────────────
// 監査ログが書けない状態は「アプリが動いている」ことと両立してしまうため、
// プロセス内に状態を持ち、health / admin から見えるようにする。さらに設定済みの
// 外部チャネルへ 1 度だけ通知する（毎エントリで通知すると障害中にチャネルを溢れさせる）。
const _failureState = {
  failures: 0,
  droppedEntries: 0,
  firstFailureAt: null,
  lastFailureAt: null,
  lastReason: null,
  lastAction: null,
  alerted: false,
};

function _recordFailure(action, message, reason) {
  const now = new Date().toISOString();
  _failureState.failures += 1;
  _failureState.droppedEntries += 1;
  if (!_failureState.firstFailureAt) _failureState.firstFailureAt = now;
  _failureState.lastFailureAt = now;
  _failureState.lastReason = `${reason}: ${message || 'unknown'}`;
  _failureState.lastAction = action;

  // 標準エラーは残す（コンテナログでの追跡用）が、それだけに頼らない。
  console.error(`[audit-log] entry NOT recorded (${reason}): ${action} — ${message || ''}`);

  if (!_failureState.alerted) {
    _failureState.alerted = true;
    // 通知は best-effort。ここで失敗しても呼び出し元には影響させない。
    try {
      require('./external-alerts').notifyAll('audit_log_write_failed', {
        reason, action, message: message || null,
      }).catch(() => {});
    } catch (_) { /* 通知経路が無くても監査の失敗記録自体は残る */ }
  }
}

/**
 * チェーンに繋げられなかったエントリを隔離ファイルへ退避する。
 * 記録そのものを失うより、繋がっていなくても残っている方がよい
 * （後から人が突き合わせられる）。隔離ファイルはチェーンの一部ではない。
 */
function quarantinePath() {
  const log = auditLogPath();
  return log.endsWith('.log') ? `${log.slice(0, -4)}-quarantine.log` : `${log}-quarantine.log`;
}

function _quarantine(entryStr, reason) {
  if (!entryStr) return;
  try {
    fs.mkdirSync(path.dirname(quarantinePath()), { recursive: true });
    fs.appendFileSync(quarantinePath(),
      JSON.stringify({ quarantinedAt: new Date().toISOString(), reason: reason || null, entry: entryStr }) + '\n');
  } catch (_) { /* 隔離にも失敗したらこれ以上できることは無い */ }
}

/** 監査ログの書き込み健全性。healthy=false なら記録が落ちている。 */
function auditWriteHealth() {
  return { healthy: _failureState.failures === 0, ..._failureState };
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

module.exports = {
  appendAuditLog, verifyAuditLogIntegrity, auditWriteHealth, quarantinePath,
  _resetAuditHealthForTest: () => {
    Object.assign(_failureState, {
      failures: 0, droppedEntries: 0, firstFailureAt: null,
      lastFailureAt: null, lastReason: null, lastAction: null, alerted: false,
    });
  },
};
