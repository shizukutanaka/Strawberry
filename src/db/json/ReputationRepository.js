// src/db/json/ReputationRepository.js
// プロバイダ・レピュテーション永続化（docs/SPECIFICATION.md: Provider reputation エンティティ）。
// providerId をキーに1レコード。既存リポジトリ準拠の JSON 実装（mkdir 安全）。
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const REPUTATIONS_PATH = path.resolve(__dirname, '../../../data/reputations.json');

function load() {
  if (!fs.existsSync(REPUTATIONS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(REPUTATIONS_PATH, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function save(rows) {
  fs.mkdirSync(path.dirname(REPUTATIONS_PATH), { recursive: true });
  fs.writeFileSync(REPUTATIONS_PATH, JSON.stringify(rows, null, 2), 'utf-8');
}

module.exports = {
  getAll: () => load(),
  getById: (id) => load().find((r) => r.id === id) || null,
  getByProviderId: (providerId) => load().find((r) => r.providerId === providerId) || null,
  create: (rec) => {
    const rows = load();
    const row = { ...rec, id: uuidv4(), createdAt: rec.createdAt || new Date().toISOString() };
    rows.push(row);
    save(rows);
    return row;
  },
  update: (id, updates) => {
    const rows = load();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...updates };
    save(rows);
    return rows[idx];
  },
};
