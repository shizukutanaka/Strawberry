// ファイルベースJSONストレージによるユーザーリポジトリ
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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
  getAll: () => loadUsers(),
  getById: (id) => loadUsers().find(u => u.id === id),
  getByUsername: (username) => loadUsers().find(u => u.username === username),
  getByEmail: (email) => loadUsers().find(u => u.email === email),
  getByApiKey: (apiKey) => loadUsers().find(u => u.apiKey === apiKey),
  create: (user) => {
    const users = loadUsers();
    const newUser = { ...user, id: uuidv4(), createdAt: new Date().toISOString() };
    users.push(newUser);
    saveUsers(users);
    return newUser;
  },
  update: (id, updates) => {
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return null;
    users[idx] = { ...users[idx], ...updates };
    saveUsers(users);
    return users[idx];
  },
  delete: (id) => {
    let users = loadUsers();
    const prevLen = users.length;
    users = users.filter(u => u.id !== id);
    saveUsers(users);
    return users.length < prevLen;
  }
};
