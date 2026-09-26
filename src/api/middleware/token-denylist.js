// src/api/middleware/token-denylist.js - JWT 失効リスト（logout 用）
// JWT はステートレスで logout 時に無効化できないため、失効済み jti を保持して
// 検証時に拒否する。エントリはトークンの exp まで保持し、それ以降は自動削除
// （exp 後はトークン自体が期限切れになるため保持不要）。
// プロセス再起動でも失効が維持されるよう JSON に永続化する。
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../../db/json/atomicWrite');

const DENYLIST_PATH = path.resolve(__dirname, '../../../data/revoked-tokens.json');

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
    // eslint-disable-next-line no-console
    console.error(`[token-denylist] WARN: Failed to load revoked-tokens.json (all prior revocations may be temporarily invalid): ${err.message}`);
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
    return false;
  }
  return true;
}

module.exports = { revoke, isRevoked };
