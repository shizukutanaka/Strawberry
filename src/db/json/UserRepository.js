// ファイルベースJSONストレージによるユーザーリポジトリ
// 他リポジトリと異なり、全アクセスを logs/db-access.log へ監査記録する（onAccess フック）。
const fs = require('fs');
const path = require('path');
const { createJsonRepository } = require('./createJsonRepository');

const AUDIT_LOG_PATH = path.resolve(__dirname, '../../../logs/db-access.log');
function writeAuditLog(action, detail) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    const entry = { timestamp: new Date().toISOString(), action, detail };
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {/* ログ失敗時はサイレント */}
}

module.exports = createJsonRepository('users.json', {
  onAccess: writeAuditLog,
  finders: {
    getByUsername: { field: 'username' },
    getByEmail: { field: 'email' },
    getByApiKey: { field: 'apiKey' },
    getByGoogleId: { field: 'googleId' },
  },
});
