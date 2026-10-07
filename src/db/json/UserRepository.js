// ファイルベースJSONストレージによるユーザーリポジトリ
// 他リポジトリと異なり、全アクセスを logs/db-access.log へ監査記録する（onAccess フック）。
const fs = require('fs');
const path = require('path');
const { createJsonRepository } = require('./createJsonRepository');
const { appendRotated, ensureLogDir } = require('../../utils/log-rotate');

const AUDIT_LOG_PATH = path.resolve(__dirname, '../../../logs/db-access.log');

// 監査ログに残してはいけないフィールド（PII・資格情報）。
// getByEmail/getByApiKey の finder は { [field]: value } として生値を
// 監査 detail へ渡すため、このままでは email/資格情報が平文でログに残る
// （弱所#17 — 実測 db-access.log 系で ~61k 件の email 記録を確認済み）。
// username は「誰を参照したか」が監査の目的そのものなので保持する。
const SENSITIVE_KEYS = new Set([
  'email', 'apiKey', 'password', 'passwordHash', 'token', 'secret',
  'totpSecret', 'googleId', 'githubId', 'peerId', 'refreshToken',
]);
function _redact(value) {
  if (Array.isArray(value)) return value.map(_redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k) ? '[redacted]' : _redact(v);
    }
    return out;
  }
  return value;
}

function writeAuditLog(action, detail) {
  try {
    ensureLogDir(AUDIT_LOG_PATH);
    const entry = { timestamp: new Date().toISOString(), action, detail: _redact(detail) };
    appendRotated(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {/* ログ失敗時はサイレント */}
}

module.exports = createJsonRepository('users.json', {
  onAccess: writeAuditLog,
  finders: {
    getByUsername: { field: 'username' },
    getByEmail: { field: 'email' },
    getByApiKey: { field: 'apiKey' },
    getByGoogleId: { field: 'googleId' },
    getByGithubId: { field: 'githubId' },
    getByPeerId: { field: 'peerId' },
  },
});
