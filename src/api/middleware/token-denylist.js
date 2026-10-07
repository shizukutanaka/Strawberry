// src/api/middleware/token-denylist.js - JWT 失効リスト（logout 用）
// JWT はステートレスで logout 時に無効化できないため、失効済み jti を保持して
// 検証時に拒否する。エントリはトークンの exp まで保持し、それ以降は自動削除
// （exp 後はトークン自体が期限切れになるため保持不要）。
// プロセス再起動でも失効が維持されるよう JSON に永続化する。
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../../db/json/atomicWrite');
const { resolveDataDir } = require('../../db/json/data-dir');
const { logger } = require('../../utils/logger');

const DENYLIST_PATH = path.join(resolveDataDir(), 'revoked-tokens.json');

// jti -> expiryMs（エポックミリ秒）
let denylist = null;
// 最後に読み込んだファイルの指紋 `${mtimeMs}:${size}`。
// denylist は初回ロード後プロセス内に固定されていたため、別プロセス
// （CLI・別ワーカー）が revoked-tokens.json に追記してもこのプロセスの
// isRevoked は古いマップを見続け、失効トークンを受理し続けた。
// stat ゲートで「ファイルが変わった時だけ再読込」にし、クロスプロセスの
// 失効を次回検証から拾えるようにする。書き込みは atomicWriteJSON（rename）
// のため mtime で確実に検知できる。
let denylistStamp = null;

function _fileStamp() {
  try {
    const s = fs.statSync(DENYLIST_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null; // ファイル不在/stat 失敗
  }
}

function load() {
  const stamp = _fileStamp();
  // stat できない（ファイル未作成）場合でも、既にロード済みのマップを維持する
  // — 不在を「全失効無し」と読み替えると revoke→isRevoked の即時整合が壊れる。
  if (denylist && (stamp === null || stamp === denylistStamp)) return denylist;
  const fresh = new Map();
  try {
    if (stamp !== null) {
      const raw = JSON.parse(fs.readFileSync(DENYLIST_PATH, 'utf-8'));
      for (const [jti, expiryMs] of Object.entries(raw)) {
        if (typeof expiryMs === 'number') fresh.set(jti, expiryMs);
      }
    }
    denylist = fresh;
  } catch (err) {
    // 破損ファイル読み込み失敗 — 必ず警告する。既ロード済みマップは維持する:
    // キャッシュを破棄すると過去の失効トークンを再受理してしまう（Devin Review 指摘）。
    // 初回ロード失敗時のみ空マップで起動継続する。
    logger.error(`[token-denylist] Failed to load revoked-tokens.json (all prior revocations may be temporarily invalid): ${err.message}`);
    try { require('../../utils/audit-log').appendAuditLog('denylist_load_failure', { error: err.message }); } catch (_) {}
    if (!denylist) denylist = fresh;
  }
  // 破損時も指紋は記録する — 同じ壊れたファイルの再パースを繰り返さないため。
  // 修復（ファイル置換）すれば指紋が変わり次回ロードで再試行される。
  denylistStamp = stamp;
  return denylist;
}

function prune(map) {
  const now = Date.now();
  for (const [jti, expiryMs] of map) {
    if (expiryMs <= now) map.delete(jti);
  }
}

function persist(map) {
  atomicWriteJSON(DENYLIST_PATH, Object.fromEntries(map));
}

// 期限切れエントリの GC。in-memory では isRevoked が都度除外するが
// prune+persist は revoke() 時にしか走らず、失効追加が無ければ期限切れ
// エントリがファイルに永遠に滞留して肥大化する。isRevoked で期限切れを
// 見つけた際に amortized persist する（毎回書くと hot path の同期 I/O に
// なるため間隔を置く — i7 の stat 指紋規約と同じ発想）。
let _lastGcPersist = 0;
const GC_PERSIST_MS = 60_000;

/**
 * トークンを失効させる。
 * @param {string} jti - トークンの一意ID
 * @param {number} expiryMs - トークンの exp（エポックミリ秒）。これ以降エントリは不要。
 */
function revoke(jti, expiryMs) {
  if (!jti) return;
  const map = load();
  prune(map);
  // Guard: if expiryMs is 0/past/NaN/null, use a 24h fallback so the entry
  // isn't pruned immediately (exp=0 bypass prevention).
  const safeExpiry = (Number.isFinite(expiryMs) && expiryMs > Date.now())
    ? expiryMs
    : Date.now() + 24 * 60 * 60 * 1000;
  map.set(jti, safeExpiry);
  persist(map);
}

/** 失効済みなら true。 */
function isRevoked(jti) {
  if (!jti) return false;
  const map = load();
  const expiryMs = map.get(jti);
  if (expiryMs === undefined) return false;
  if (expiryMs <= Date.now()) {
    map.delete(jti);
    if (Date.now() - _lastGcPersist >= GC_PERSIST_MS) {
      _lastGcPersist = Date.now();
      prune(map);
      try {
        persist(map);
      } catch (_) {
        /* GC の永続化失敗は次回チェックへ持ち越し（メモリ側は既に除去済み） */
      }
    }
    return false;
  }
  return true;
}

module.exports = { revoke, isRevoked };
