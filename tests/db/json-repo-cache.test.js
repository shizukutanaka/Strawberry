// tests/db/json-repo-cache.test.js
// createJsonRepository の stat 指紋キャッシュ:
//  - ファイル無変更の連続読み込みではディスク再読しない（N+1 I/O 抑止の中核）
//  - 別プロセス相当の外部書き込みは指紋変化で即座に反映される
//  - 返却レコードへの改変がキャッシュを汚染しない（複製返却）
//  - 破損ファイルは従来通り fail-closed で throw（キャッシュで握り潰さない）
const fs = require('fs');
const path = require('path');
const { createJsonRepository } = require('../../src/db/json/createJsonRepository');

const DATA_DIR = path.resolve(__dirname, '../../data');
const FILE = `__cache_probe_${process.pid}.json`;
const FULL = path.join(DATA_DIR, FILE);

const writeFile = (rows) => fs.writeFileSync(FULL, JSON.stringify(rows), 'utf-8');

describe('createJsonRepository: stat-gated read cache', () => {
  beforeAll(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  });
  afterEach(() => {
    try { fs.unlinkSync(FULL); } catch (_) {}
    jest.restoreAllMocks();
  });

  it('serves repeated reads without re-reading an unchanged file', () => {
    writeFile([{ id: 'a', v: 1 }]);
    const repo = createJsonRepository(FILE);
    const spy = jest.spyOn(fs, 'readFileSync');
    repo.getAll();
    repo.getById('a');
    repo.getAll();
    const reads = spy.mock.calls.filter(c => String(c[0]) === FULL).length;
    expect(reads).toBe(1);
  });

  it('picks up external writes (cross-process) via fingerprint change', () => {
    writeFile([{ id: 'a', v: 1 }]);
    const repo = createJsonRepository(FILE);
    expect(repo.getById('a').v).toBe(1);
    // プロセス外更新相当: 直接ファイルを書き換える（mtime/size が変わる）
    writeFile([{ id: 'a', v: 2 }, { id: 'b', v: 3 }]);
    expect(repo.getById('a').v).toBe(2);
    expect(repo.getById('b').v).toBe(3);
  });

  it('does not let callers mutate the cache via returned rows', () => {
    writeFile([{ id: 'a', v: 1, nested: { x: 1 } }]);
    const repo = createJsonRepository(FILE);
    const first = repo.getAll();
    first[0].v = 999;
    first[0].nested.x = 999;
    first.push({ id: 'injected' });
    const second = repo.getAll();
    expect(second).toHaveLength(1);
    expect(second[0].v).toBe(1);
    expect(second[0].nested.x).toBe(1);
  });

  it('sees its own writes through the cache (create → getById)', () => {
    writeFile([]);
    const repo = createJsonRepository(FILE);
    const row = repo.create({ v: 7 });
    expect(repo.getById(row.id).v).toBe(7);
    repo.update(row.id, { v: 8 });
    expect(repo.getById(row.id).v).toBe(8);
    repo.delete(row.id);
    expect(repo.getById(row.id)).toBeNull();
  });

  it('still fails closed on a corrupt file (no stale-cache fallback)', () => {
    fs.writeFileSync(FULL, '{ broken', 'utf-8');
    const repo = createJsonRepository(FILE);
    expect(() => repo.getAll()).toThrow(/corrupt/i);
  });
});
