// tests/db/json-repo-batch.test.js
// createMany / deleteMany: ループ内の create/delete が反復ごとに JSON 全量を
// 読み直し+書き込みする N+1 I/O を、単一の load+atomicWrite に畳むバッチ
// プリミティブの契約を検証する。
const fs = require('fs');
const path = require('path');
const { createJsonRepository } = require('../../src/db/json/createJsonRepository');

const DATA_DIR = path.resolve(__dirname, '../../data');
const FILE = `__batch_probe_${process.pid}.json`;
const FULL = path.join(DATA_DIR, FILE);

function readRows() {
  return JSON.parse(fs.readFileSync(FULL, 'utf-8'));
}

describe('createJsonRepository batch primitives', () => {
  beforeEach(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { fs.unlinkSync(FULL); } catch (_) {}
  });
  afterEach(() => {
    try { fs.unlinkSync(FULL); } catch (_) {}
  });

  describe('createMany', () => {
    it('inserts all records in one call, assigning id/createdAt to each', () => {
      const repo = createJsonRepository(FILE);
      const created = repo.createMany([{ a: 1 }, { a: 2 }, { a: 3 }]);
      expect(created).toHaveLength(3);
      created.forEach((r) => {
        expect(r.id).toBeTruthy();
        expect(r.createdAt).toBeTruthy();
      });
      // ids must be unique
      expect(new Set(created.map(r => r.id)).size).toBe(3);
      const rows = readRows();
      expect(rows).toHaveLength(3);
      expect(rows.map(r => r.a).sort()).toEqual([1, 2, 3]);
    });

    it('appends to existing rows without losing them', () => {
      const repo = createJsonRepository(FILE);
      repo.create({ keep: true });
      repo.createMany([{ x: 1 }, { x: 2 }]);
      const rows = readRows();
      expect(rows).toHaveLength(3);
      expect(rows.some(r => r.keep)).toBe(true);
    });

    it('respects caller-provided createdAt', () => {
      const repo = createJsonRepository(FILE);
      const created = repo.createMany([{ a: 1, createdAt: '2020-01-01T00:00:00.000Z' }]);
      expect(created[0].createdAt).toBe('2020-01-01T00:00:00.000Z');
    });

    it('strips prototype-pollution keys just like create()', () => {
      const repo = createJsonRepository(FILE);
      repo.createMany([JSON.parse('{"a":1,"__proto__":{"polluted":true}}')]);
      const rows = readRows();
      expect(rows).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(rows[0], '__proto__')).toBe(false);
      expect({}.polluted).toBeUndefined();
    });

    it('is a no-op for empty input (no file write)', () => {
      const repo = createJsonRepository(FILE);
      expect(repo.createMany([])).toEqual([]);
      expect(repo.createMany(null)).toEqual([]);
      expect(fs.existsSync(FULL)).toBe(false);
    });
  });

  describe('deleteMany', () => {
    it('removes all matching ids in one call and returns the count', () => {
      const repo = createJsonRepository(FILE);
      const a = repo.create({ v: 'a' });
      const b = repo.create({ v: 'b' });
      const c = repo.create({ v: 'c' });
      const n = repo.deleteMany([a.id, b.id]);
      expect(n).toBe(2);
      const rows = readRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(c.id);
    });

    it('returns 0 and leaves the file untouched when nothing matches', () => {
      const repo = createJsonRepository(FILE);
      repo.create({ v: 'a' });
      const before = fs.readFileSync(FULL, 'utf-8');
      expect(repo.deleteMany(['nonexistent-id'])).toBe(0);
      expect(fs.readFileSync(FULL, 'utf-8')).toBe(before);
    });

    it('is a no-op for empty input', () => {
      const repo = createJsonRepository(FILE);
      repo.create({ v: 'a' });
      expect(repo.deleteMany([])).toBe(0);
      expect(repo.deleteMany(undefined)).toBe(0);
      expect(readRows()).toHaveLength(1);
    });
  });
});
