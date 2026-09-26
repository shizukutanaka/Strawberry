// src/api/utils/auth-user-lookup.js
// 認証系コンテキスト（jwt-auth / security / GraphQL context）がリクエストごとに呼ぶ
// 「このユーザーが存在し、無効化されていないか」の判定専用ルックアップ。
//
// UserRepository.getById は呼ぶたび users.json 全量を readFileSync+JSON.parse するため、
// 全認証済みリクエストが users.json の全量ファイル I/O を1回ずつ踏むボトルネックだった。
// ここでは fs.statSync の (mtimeMs, size) をゲートにして、ファイル変更時のみ再パースした
// Map（id → 判定に必要なフィールドのみの軽量レコード）を使い回す。
//
// 安全性:
// - 返すのは行オブジェクトではなく3フィールドのみのコピー → 呼び出し側のミューテーションが
//   キャッシュ・他リクエストへ漏洩しない（共有行オブジェクトの返却はしない）。
// - statSync はこのプロセス外の書き込み（他ワーカー・テスト）も検出できる。
// - stat 失敗時は「空 Map（存在しないユーザー扱い）」ではなくリポジトリへフォールバックし、
//   判定不能でフェイルオープンしない。
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.resolve(__dirname, '../../data/users.json');

let cacheStamp = null; // `${mtimeMs}:${size}` — ファイル変更検知の指紋
let cacheMap = null;   // id -> { status, passwordChangedAt, sessionsRevokedAt }

// jwt-auth/security/graphql が必要とするのは status と session-invalidation の
// 2 フィールドだけ。他のユーザー属性は認証判定に使わないのでコピーしない。
const AUTH_FIELDS = ['status', 'passwordChangedAt', 'sessionsRevokedAt'];

function rebuildCache() {
  const UserRepository = require('../../db/json/UserRepository');
  const map = new Map();
  for (const u of UserRepository.getAll()) {
    if (u && u.id != null) {
      const rec = {};
      for (const f of AUTH_FIELDS) rec[f] = u[f];
      // キャッシュはリクエストを跨いで共有されるため、呼び出し側のミューテーションが
      // 他リクエストへ漏洩しないよう不変化する（認証レコードは読み取り専用）。
      map.set(u.id, Object.freeze(rec));
    }
  }
  cacheMap = map;
}

/**
 * 認証判定用に最小限のユーザーレコードを返す。存在しなければ null。
 * @returns {{status: string|undefined, passwordChangedAt: any, sessionsRevokedAt: any}|null}
 */
function getAuthUser(userId) {
  if (!userId) return null;
  let stamp = null;
  try {
    const stat = fs.statSync(USERS_FILE);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // users.json が存在しない/読めない → キャッシュせず都度リポジトリ経由で判定
    const UserRepository = require('../../db/json/UserRepository');
    return UserRepository.getById(userId) || null;
  }
  if (cacheStamp !== stamp) {
    rebuildCache();
    cacheStamp = stamp;
  }
  return cacheMap.get(userId) || null;
}

// テスト用: キャッシュを明示的にクリア
function _resetAuthUserCache() {
  cacheStamp = null;
  cacheMap = null;
}

module.exports = { getAuthUser, _resetAuthUserCache };
