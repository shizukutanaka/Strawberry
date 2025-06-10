// ファイルベースJSONストレージによるユーザーリポジトリ
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const AUDIT_LOG_PATH = path.resolve(__dirname, '../../../logs/db-access.log');
function writeAuditLog(action, detail) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    const entry = { timestamp: new Date().toISOString(), action, detail };
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {/* ログ失敗時はサイレント */}
}

const USERS_PATH = path.resolve(__dirname, '../../../data/users.json');

function loadUsers() {
  if (!fs.existsSync(USERS_PATH)) return [];
  const raw = fs.readFileSync(USERS_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), 'utf-8');
}

module.exports = {
  getAll: () => {
    const result = loadUsers();
    writeAuditLog('getAll', { count: result.length });
    return result;
  },
  getById: (id) => {
    const user = loadUsers().find(u => u.id === id);
    writeAuditLog('getById', { id, found: !!user });
    return user;
  },
  getByUsername: (username) => {
    const user = loadUsers().find(u => u.username === username);
    writeAuditLog('getByUsername', { username, found: !!user });
    return user;
  },
  getByEmail: (email) => {
    const user = loadUsers().find(u => u.email === email);
    writeAuditLog('getByEmail', { email, found: !!user });
    return user;
  },
  getByApiKey: (apiKey) => {
    const user = loadUsers().find(u => u.apiKey === apiKey);
    writeAuditLog('getByApiKey', { apiKey, found: !!user });
    return user;
  },
  create: (user) => {
    const users = loadUsers();
    const newUser = { ...user, id: uuidv4(), createdAt: new Date().toISOString() };
    users.push(newUser);
    saveUsers(users);
    writeAuditLog('create', { id: newUser.id, email: newUser.email });
    return newUser;
  },
  update: (id, updates) => {
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) {
      writeAuditLog('update', { id, result: 'not_found' });
      return null;
    }
    users[idx] = { ...users[idx], ...updates };
    saveUsers(users);
    writeAuditLog('update', { id, updates });
    return users[idx];
  },
  delete: (id) => {
    let users = loadUsers();
    const prevLen = users.length;
    users = users.filter(u => u.id !== id);
    saveUsers(users);
    writeAuditLog('delete', { id, deleted: users.length < prevLen });
    return users.length < prevLen;
  }
};
