// src/db/json/VerificationRepository.js
// 検証レコード永続化（docs/SPECIFICATION.md: Verification record エンティティ）。
// jobId 単位。既存リポジトリ準拠の JSON 実装（mkdir 安全）。
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const VERIFICATIONS_PATH = path.resolve(__dirname, '../../../data/verifications.json');

function load() {
  if (!fs.existsSync(VERIFICATIONS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(VERIFICATIONS_PATH, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function save(rows) {
  fs.mkdirSync(path.dirname(VERIFICATIONS_PATH), { recursive: true });
  fs.writeFileSync(VERIFICATIONS_PATH, JSON.stringify(rows, null, 2), 'utf-8');
}

module.exports = {
  getAll: () => load(),
  getById: (id) => load().find((r) => r.id === id) || null,
  getByJobId: (jobId) => load().find((r) => r.jobId === jobId) || null,
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
