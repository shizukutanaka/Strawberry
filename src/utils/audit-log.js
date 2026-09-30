// 監査ログ自動記録・改ざん検知ユーティリティ
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteString } = require('../db/json/atomicWrite');

const DEFAULT_LOG_PATH = path.join(__dirname, '../../logs/audit.log');

// ディスク枯渇防止: ログファイルがこのサイズを超えたら新規エントリを拒否し警告を出す。
// 認証済みユーザーが監査対象アクション（異常検知・webhook 失敗等）を連打することで
// ディスクをフルにし、audit.log のサイレント失敗と引き換えにサービス全体を落とせる。
// MAX_AUDIT_LOG_MB の検証は厳密に行う。緩い parseInt は3系統の故障を招く:
// - '0oops' のような部分一致を通すと 0 と解釈され監査全体が黙って停止する
// - NaN/負値をそのまま掛けると全サイズ比較が false になり上限が無言で無効化される
// - 巨大整数は MB→bytes 換算で Infinity となり、同じく比較を常時 false にする
// 数字のみの完全一致を要求し、NaN/負値/上限超過は既定 50MB へフォールバックする
// （明示的な '0' のみ「監査停止」の意図指定として残す）。
const _auditLogMbEnv = process.env.MAX_AUDIT_LOG_MB;
const _auditLogMbParsed = _auditLogMbEnv !== undefined && _auditLogMbEnv !== ''
  ? (/^\d+$/.test(_auditLogMbEnv.trim()) ? parseInt(_auditLogMbEnv, 10) : NaN)
  : 50;
// MB 指定の上限は 1TB — これを超える指定は設定ミスと見做す（Infinity 化防止）
const MAX_AUDIT_LOG_BYTES = (Number.isFinite(_auditLogMbParsed)
  && _auditLogMbParsed >= 0
  && _auditLogMbParsed <= 1048576
  ? _auditLogMbParsed
  : 50) * 1024 * 1024;

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
        // eslint-disable-next-line no-console
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
  try {
    // 明示的な 0 指定は監査停止の意図指定 — ファイル未作成時も含め一切書き込まない
    if (MAX_AUDIT_LOG_BYTES === 0) return;
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
    // ディスク枯渇防止: ファイルサイズが上限を超えていたら書き込みをスキップして警告。
    // ENOSPC で例外が飛んでもサイレントに飲み込むと監査証跡がダークになるため、
    // 上限手前で先んじてアラートを出し、運用者が対処できるようにする。
    try {
      const stat = fs.statSync(logPath);
      if (stat.size >= MAX_AUDIT_LOG_BYTES) {
        // eslint-disable-next-line no-console
        console.error(`[audit-log] ALERT: audit log has reached size limit (${Math.round(stat.size / 1024 / 1024)}MB >= ${MAX_AUDIT_LOG_BYTES / 1024 / 1024}MB). Entry dropped: ${action}`);
        return;
      }
    } catch (_statErr) { /* file may not exist yet — that's fine */ }
    fs.appendFileSync(logPath, entryStr + '\n');
    atomicWriteString(hashPath, hash);
    // キャッシュ更新: 次回呼び出しのための prevHash
    _hashCache.set(logPath, { prevHash: hash });
  } catch (e) {
    // 監査ログ書き込み失敗はサイレントに記録し、呼び出し元をクラッシュさせない。
    // ENOSPC（ディスクフル）の場合は特に目立つメッセージで警告。
    const isEnospc = e && (e.code === 'ENOSPC' || (e.message && e.message.includes('ENOSPC')));
    // eslint-disable-next-line no-console
    console.error(`[audit-log] ${isEnospc ? 'CRITICAL DISK FULL — ' : ''}Failed to write audit entry: ${action}`, e && e.message);
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

module.exports = { appendAuditLog, verifyAuditLogIntegrity, MAX_AUDIT_LOG_BYTES };
