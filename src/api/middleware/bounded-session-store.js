// src/api/middleware/bounded-session-store.js
// express-session 既定の MemoryStore は期限切れセッションをアクセス時の
// 遅延拒否以外で退去させず、ユニーク sid を連発するリクエスト（bot が
// /master-auth/* を叩く等）で無制限に成長する。このストアは同一の
// get/set/destroy/touch 契約を Map+TTL で実装し、maxEntries を超えた
// 新規挿入時に失効分を全削除→最古エントリを追い出すことで境界化する。
// sliding-window レートリミッターの maxKeys と同じクラスの対策。
const { Store } = require('express-session');

const SESSION_MAX_ENTRIES = parseInt(process.env.SESSION_MAX_ENTRIES, 10) || 10_000;
// クッキーに expires が無いセッションの既定寿命（24h）。
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

class BoundedSessionStore extends Store {
  constructor({ maxEntries = SESSION_MAX_ENTRIES } = {}) {
    super();
    this._max = maxEntries;
    this._sessions = new Map();
  }

  get(sid, cb) {
    const entry = this._sessions.get(sid);
    if (!entry || entry.expires <= Date.now()) {
      if (entry) this._sessions.delete(sid);
      return cb(null, null);
    }
    return cb(null, JSON.parse(entry.data));
  }

  set(sid, sess, cb) {
    const expires = sess && sess.cookie && sess.cookie.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + DEFAULT_TTL_MS;
    if (!this._sessions.has(sid) && this._sessions.size >= this._max) {
      this._pruneExpired();
      while (this._sessions.size >= this._max) {
        const oldest = this._sessions.keys().next().value;
        this._sessions.delete(oldest);
      }
    }
    this._sessions.set(sid, { data: JSON.stringify(sess), expires });
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    this._sessions.delete(sid);
    if (cb) cb(null);
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }

  _pruneExpired() {
    const now = Date.now();
    for (const [sid, entry] of this._sessions) {
      if (entry.expires <= now) this._sessions.delete(sid);
    }
  }
}

module.exports = { BoundedSessionStore };
