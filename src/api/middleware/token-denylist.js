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

function load() {
  if (denylist) return denylist;
  denylist = new Map();
  try {
    if (fs.existsSync(DENYLIST_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DENYLIST_PATH, 'utf-8'));
      for (const [jti, expiryMs] of Object.entries(raw)) {
        if (typeof expiryMs === 'number') denylist.set(jti, expiryMs);
      }
    }
  } catch (_) {
    // 破損時は空から再開（失効情報の喪失より起動継続を優先。トークンは exp で自然失効する）
  }
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
