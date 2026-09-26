// §8: createJsonRepository の原子的整合性プリミティブ（updateWhere / createIfAbsent）。
const fs = require('fs');
const path = require('path');
const { createJsonRepository } = require('../../src/db/json/createJsonRepository');

const DATA_DIR = path.resolve(__dirname, '../../data');
const FILE = `__atomic_probe_${process.pid}.json`;
const FULL = path.join(DATA_DIR, FILE);

describe('createJsonRepository atomic helpers (§8)', () => {
  afterEach(() => { try { fs.unlinkSync(FULL); } catch (_) {} });

  it('createIfAbsent inserts once and returns exists on second call', () => {
    const repo = createJsonRepository(FILE);
    const first = repo.createIfAbsent((r) => r.providerId === 'p1', { providerId: 'p1', stake: 100 });
    expect(first.ok).toBe(true);
    const second = repo.createIfAbsent((r) => r.providerId === 'p1', { providerId: 'p1', stake: 999 });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('exists');
    expect(repo.getAll().filter((r) => r.providerId === 'p1')).toHaveLength(1);
  });

  it('updateWhere computes updates against the CURRENT row (no stale read-modify-write)', () => {
    const repo = createJsonRepository(FILE);
    repo.create({ providerId: 'p1', stats: { balance: 100 } });
    // 「読んでから書く」ではなく compute が最新行を受け取ることを確認:
    // compute 内で外部から見える値が load 時点のものである
    const res = repo.updateWhere((r) => r.providerId === 'p1', (current) => {
      expect(current.stats.balance).toBe(100);
      return { stats: { balance: current.stats.balance + 50 } };
    });
    expect(res.ok).toBe(true);
    expect(res.row.stats.balance).toBe(150);
  });

  it('updateWhere aborts without writing when compute returns null', () => {
    const repo = createJsonRepository(FILE);
    const created = repo.create({ providerId: 'p1', stats: { balance: 100 } });
    const res = repo.updateWhere((r) => r.providerId === 'p1', () => null);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('aborted');
    expect(repo.getById(created.id).stats.balance).toBe(100); // 変更なし
  });

  it('updateWhere returns not_found for missing rows', () => {
    const repo = createJsonRepository(FILE);
    expect(repo.updateWhere(() => false, () => ({})).reason).toBe('not_found');
  });

  it('strips dangerous keys in updateWhere/createIfAbsent payloads', () => {
    const repo = createJsonRepository(FILE);
    repo.createIfAbsent(() => false, { providerId: 'p1', stats: {}, evil: { __proto__: { polluted: true } } });
    const res = repo.updateWhere((r) => r.providerId === 'p1', () => ({ '__proto__': { x: 1 }, note: 'ok' }));
    expect(res.ok).toBe(true);
    expect(res.row.note).toBe('ok');
    expect({}.polluted).toBeUndefined();
  });
});
