// tests/db/json-repo-concurrency.test.js
// createJsonRepository の変更系が、複数プロセスから同時に呼ばれても更新を失わないこと。
//
// atomicWrite（temp+rename）は**書き込み自体**を原子的にし、読み手が中途半端なファイルを
// 見ること（torn read）を防ぐ。しかし `load() → 変更 → write()` の**系列**は保護しないため、
// 2 プロセスが同時に別レコードを更新すると後勝ちで一方が消える。これは orders/payments/
// escrows で起きれば資金記録の消失になる（ARCHITECTURE.md「既知の重大ギャップ」）。
// ここではロック結線の回帰ガードとして、実リポジトリ API を子プロセスから叩く。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const FACTORY = path.join(REPO_ROOT, 'src/db/json/createJsonRepository.js');

const fileName = `locktest-${Date.now()}-${process.pid}.json`;
const dataPath = path.join(REPO_ROOT, 'data', fileName);

afterAll(() => {
  for (const p of [dataPath, `${dataPath}.lock`]) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
});

function runChildren(count, script) {
  const procs = [];
  for (let c = 0; c < count; c++) {
    procs.push(spawn(process.execPath, ['-e', script], { cwd: REPO_ROOT, stdio: 'inherit' }));
  }
  return Promise.all(procs.map((p) => new Promise((resolve, reject) => {
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
    p.on('error', reject);
  })));
}

describe('createJsonRepository under concurrent processes', () => {
  it('keeps every concurrently created row', async () => {
    const CHILDREN = 4;
    const ITER = 12;
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    fs.writeFileSync(dataPath, '[]');

    await runChildren(CHILDREN, `
      const { createJsonRepository } = require(${JSON.stringify(FACTORY)});
      const repo = createJsonRepository(${JSON.stringify(fileName)});
      for (let i = 0; i < ${ITER}; i++) repo.create({ pid: process.pid, i });
    `);

    const rows = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    // ロックが外れると後勝ちで消え、ここが CHILDREN*ITER を下回る
    expect(rows).toHaveLength(CHILDREN * ITER);
    // 一意な id が採番され、重複していないこと
    expect(new Set(rows.map((r) => r.id)).size).toBe(CHILDREN * ITER);

    const byPid = new Map();
    for (const r of rows) byPid.set(r.pid, (byPid.get(r.pid) || 0) + 1);
    expect(byPid.size).toBe(CHILDREN);
    for (const n of byPid.values()) expect(n).toBe(ITER);
  }, 40000);

  it('keeps concurrent updates to different rows', async () => {
    const { createJsonRepository } = require('../../src/db/json/createJsonRepository');
    const repo = createJsonRepository(fileName);
    fs.writeFileSync(dataPath, '[]');

    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(repo.create({ slot: i }).id);

    // 各子プロセスが自分の 1 行だけを更新する。ロックが無ければ、別の行を触った
    // 子の書き込みに踏み潰されて marked が消える。
    await Promise.all(ids.map((id, idx) => runChildren(1, `
      const { createJsonRepository } = require(${JSON.stringify(FACTORY)});
      const repo = createJsonRepository(${JSON.stringify(fileName)});
      for (let i = 0; i < 8; i++) repo.update(${JSON.stringify(id)}, { marked: true, by: ${idx}, i });
    `)));

    const rows = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.marked).toBe(true); // どの行の更新も失われていない
    }
    expect(new Set(rows.map((r) => r.by)).size).toBe(4);
  }, 40000);

  it('does not leave a lock file behind', () => {
    expect(fs.existsSync(`${dataPath}.lock`)).toBe(false);
  });
});
