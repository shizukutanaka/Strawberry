// src/db/json/createJsonRepository.js
// 7つのJSONリポジトリ（Gpu/Order/Payment/User/Escrow/Reputation/Verification）の
// 重複していた load/save/CRUD 実装を一本化するファクトリ。
// すべての書き込みは atomicWriteJSON（temp+rename）経由で行う。
//
// 契約:
//  - getById / 単一ファインダは「見つからなければ null」を返す
//    （サービス層テストのモックと同一契約。旧実装の undefined も falsy のため互換)
//  - create は id を必ず採番し直し、createdAt は呼び出し側指定があれば尊重する
//  - finders: { name: { field, many } } で getByXxx を宣言的に生成する
//  - onAccess(action, detail): 監査フック（UserRepository の db-access.log 用）。
//    フックの失敗は本処理に影響させない。
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { atomicWriteJSON } = require('./atomicWrite');

function createJsonRepository(fileName, { finders = {}, onAccess } = {}) {
  const filePath = path.resolve(__dirname, '../../../data', fileName);

  const audit = (action, detail) => {
    if (!onAccess) return;
    try { onAccess(action, detail); } catch (e) { /* 監査失敗はサイレント */ }
  };

  function load() {
    if (!fs.existsSync(filePath)) return [];
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      return [];
    }
  }

  const repo = {
    getAll: () => {
      const rows = load();
      audit('getAll', { count: rows.length });
      return rows;
    },
    getById: (id) => {
      const row = load().find((r) => r.id === id) || null;
      audit('getById', { id, found: !!row });
      return row;
    },
    create: (rec) => {
      const rows = load();
      const row = { ...rec, id: uuidv4(), createdAt: rec.createdAt || new Date().toISOString() };
      rows.push(row);
      atomicWriteJSON(filePath, rows);
      audit('create', { id: row.id });
      return row;
    },
    update: (id, updates) => {
      const rows = load();
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) {
        audit('update', { id, result: 'not_found' });
        return null;
      }
      rows[idx] = { ...rows[idx], ...updates };
      atomicWriteJSON(filePath, rows);
      audit('update', { id, updates });
      return rows[idx];
    },
    delete: (id) => {
      const rows = load();
      const remaining = rows.filter((r) => r.id !== id);
      const deleted = remaining.length < rows.length;
      atomicWriteJSON(filePath, remaining);
      audit('delete', { id, deleted });
      return deleted;
    },
  };

  for (const [name, spec] of Object.entries(finders)) {
    const { field, many = false } = spec;
    repo[name] = (value) => {
      if (many) {
        const rows = load().filter((r) => r[field] === value);
        audit(name, { [field]: value, count: rows.length });
        return rows;
      }
      const row = load().find((r) => r[field] === value) || null;
      audit(name, { [field]: value, found: !!row });
      return row;
    };
  }

  return repo;
}

module.exports = { createJsonRepository };
