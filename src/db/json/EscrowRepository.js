// src/db/json/EscrowRepository.js
// ファイルベースJSONストレージによるエスクロー・リポジトリ（docs/SPECIFICATION.md: Escrow エンティティ）。
// 既存の OrderRepository 等と同じパターン。data/ ディレクトリが無い場合に備え mkdir する。
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const ESCROWS_PATH = path.resolve(__dirname, '../../../data/escrows.json');

function load() {
  if (!fs.existsSync(ESCROWS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(ESCROWS_PATH, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function save(rows) {
  fs.mkdirSync(path.dirname(ESCROWS_PATH), { recursive: true });
  fs.writeFileSync(ESCROWS_PATH, JSON.stringify(rows, null, 2), 'utf-8');
}

module.exports = {
  getAll: () => load(),
  getById: (id) => load().find((e) => e.id === id) || null,
  getByOrderId: (orderId) => load().filter((e) => e.orderId === orderId),
  create: (rec) => {
    const rows = load();
    const row = { ...rec, id: uuidv4(), createdAt: rec.createdAt || new Date().toISOString() };
    rows.push(row);
    save(rows);
    return row;
  },
  update: (id, updates) => {
    const rows = load();
    const idx = rows.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...updates };
    save(rows);
    return rows[idx];
  },
};
