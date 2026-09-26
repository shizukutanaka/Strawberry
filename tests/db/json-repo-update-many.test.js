// createJsonRepository.updateMany の単体検証。
// 複数行の部分更新を 1 load + 1 atomicWrite に束ねるプリミティブ。
const fs = require('fs');
const path = require('path');
const { createJsonRepository } = require('../../src/db/json/createJsonRepository');

const DATA_DIR = path.resolve(__dirname, '../../data');
const FILE = `__updatemany_probe_${process.pid}.json`;
const FULL = path.join(DATA_DIR, FILE);

describe('createJsonRepository.updateMany', () => {
  beforeEach(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { fs.unlinkSync(FULL); } catch (_) {}
  });
  afterEach(() => {
    try { fs.unlinkSync(FULL); } catch (_) {}
  });

  it('applies partial updates to multiple rows in one write', () => {
    const repo = createJsonRepository(FILE);
    const a = repo.create({ k: 'a', v: 1 });
    const b = repo.create({ k: 'b', v: 2 });
    const c = repo.create({ k: 'c', v: 3 });

    const res = repo.updateMany([
      { id: a.id, updates: { v: 10 } },
      { id: c.id, updates: { v: 30, extra: 'x' } },
    ]);

    expect(res.updated).toBe(2);
    const rows = repo.getAll();
    expect(rows.find(r => r.id === a.id).v).toBe(10);
    expect(rows.find(r => r.id === b.id).v).toBe(2); // 未指定行は不変
    expect(rows.find(r => r.id === c.id).v).toBe(30);
    expect(rows.find(r => r.id === c.id).extra).toBe('x');
  });

  it('skips unknown ids instead of failing the whole batch', () => {
    const repo = createJsonRepository(FILE);
    const a = repo.create({ k: 'a', v: 1 });
    const res = repo.updateMany([
      { id: a.id, updates: { v: 9 } },
      { id: 'no-such-id', updates: { v: 99 } },
      { id: null, updates: { v: 99 } },
    ]);
    expect(res.updated).toBe(1);
    expect(repo.getById(a.id).v).toBe(9);
  });

  it('returns 0 and writes nothing for empty input', () => {
    const repo = createJsonRepository(FILE);
    repo.create({ k: 'a' });
    const before = fs.readFileSync(FULL, 'utf-8');
    expect(repo.updateMany([]).updated).toBe(0);
    expect(repo.updateMany(null).updated).toBe(0);
    expect(fs.readFileSync(FULL, 'utf-8')).toBe(before);
  });

  it('returns 0 without writing when no ids match', () => {
    const repo = createJsonRepository(FILE);
    repo.create({ k: 'a' });
    const before = fs.readFileSync(FULL, 'utf-8');
    const res = repo.updateMany([{ id: 'ghost', updates: { v: 1 } }]);
    expect(res.updated).toBe(0);
    expect(fs.readFileSync(FULL, 'utf-8')).toBe(before);
  });

  it('strips dangerous keys from updates (prototype pollution guard)', () => {
    const repo = createJsonRepository(FILE);
    const a = repo.create({ k: 'a', safe: true });
    repo.updateMany([
      { id: a.id, updates: JSON.parse('{"__proto__": {"polluted": true}, "v": 5}') },
    ]);
    const row = repo.getById(a.id);
    expect(row.v).toBe(5);
    expect(Object.prototype.polluted).toBeUndefined();
    expect(row.polluted).toBeUndefined();
  });
});
