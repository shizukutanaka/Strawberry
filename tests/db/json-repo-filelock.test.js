// createJsonRepository のクロスプロセス書き込みロック（§8 lost-update 対策）
// proper-lockfile による <file>.lock の直列化を検証:
//  - 外部保持ロック下の書き込みは fail-closed で throw
//  - ロック解放後は通常通り書き込める（ロックが取りっぱなしにならない）
const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');
const { createJsonRepository } = require('../../src/db/json/createJsonRepository');

const FILE = `__filelock_${process.pid}_${Date.now()}.json`;
const DATA_DIR = path.resolve(__dirname, '../../data');
const FILE_PATH = path.join(DATA_DIR, FILE);
const LOCK_PATH = `${FILE_PATH}.lock`;

function cleanup() {
  for (const p of [FILE_PATH, LOCK_PATH]) {
    try { fs.unlinkSync(p); } catch (e) { /* nonexistent */ }
  }
}

describe('createJsonRepository: cross-process write lock', () => {
  afterEach(cleanup);
  afterAll(cleanup);

  test('ロック保持中の create は fail-closed で throw し、解放後は成功する', () => {
    // 事前にファイルを作っておく（realpath:false でも外部ロック検証を確実にする）
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE_PATH, '[]');
    // 別プロセスを模倣して外部からロックを保持
    const release = lockfile.lockSync(FILE_PATH, { realpath: false, stale: 60_000 });
    try {
      const repo = createJsonRepository(FILE);
      expect(() => repo.create({ name: 'x' })).toThrow(/write lock/);
    } finally {
      release();
    }
    // 解放後は普通に書き込める
    const repo2 = createJsonRepository(FILE);
    const row = repo2.create({ name: 'ok' });
    expect(row.id).toBeTruthy();
    expect(repo2.getAll()).toHaveLength(1);
  });

  test('連続する書き込みは各々ロック取得/解放される（残余ロックなし）', () => {
    const repo = createJsonRepository(FILE);
    const r1 = repo.create({ n: 1 });
    const r2 = repo.create({ n: 2 });
    repo.update(r1.id, { n: 10 });
    repo.delete(r2.id);
    expect(repo.getAll()).toEqual([expect.objectContaining({ id: r1.id, n: 10 })]);
    // ロックファイルは解放されている（再取得できる）
    const release = lockfile.lockSync(FILE_PATH, { realpath: false, stale: 60_000 });
    release();
  });
});
