// tests/db/fileLock.test.js
// JSON データファイルのクロスプロセス排他ロック。
// ARCHITECTURE.md が「マルチプロセス運用前に必須」と記していた lost-update ギャップの土台。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _execFileSync } = require('child_process');

const lock = require('../../src/db/json/fileLock');

let dir;
let target;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filelock-'));
  target = path.join(dir, 'data.json');
  lock._resetHeld();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('acquire / release', () => {
  it('creates a lock file while held and removes it on release', () => {
    const release = lock.acquire(target);
    expect(fs.existsSync(lock.lockPathFor(target))).toBe(true);
    release();
    expect(fs.existsSync(lock.lockPathFor(target))).toBe(false);
  });

  it('records the holder pid for diagnosing a stuck lock', () => {
    const release = lock.acquire(target);
    expect(fs.readFileSync(lock.lockPathFor(target), 'utf-8')).toContain(String(process.pid));
    release();
  });

  it('is idempotent on double release', () => {
    const release = lock.acquire(target);
    release();
    expect(() => release()).not.toThrow();
  });

  it('is re-entrant within the same process (no self-deadlock)', () => {
    // 入れ子で同じパスのロックを取っても詰まらないこと。将来 mutate の中から別の
    // リポジトリ操作を呼んだときに自己デッドロックしないための保険。
    const outer = lock.acquire(target);
    const inner = lock.acquire(target);
    expect(fs.existsSync(lock.lockPathFor(target))).toBe(true);
    inner();
    // 内側を離しただけではまだ保持している
    expect(fs.existsSync(lock.lockPathFor(target))).toBe(true);
    outer();
    expect(fs.existsSync(lock.lockPathFor(target))).toBe(false);
  });

  it('gives different files independent locks', () => {
    const other = path.join(dir, 'other.json');
    const a = lock.acquire(target);
    const b = lock.acquire(other); // 別ファイルなので待たされない
    a(); b();
  });
});

describe('withFileLock', () => {
  it('releases the lock even when the body throws', () => {
    expect(() => lock.withFileLock(target, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(lock.lockPathFor(target))).toBe(false);
  });

  it('returns the body result', () => {
    expect(lock.withFileLock(target, () => 42)).toBe(42);
  });
});

describe('stale lock recovery', () => {
  it('steals a lock left behind by a dead process', () => {
    // 保持プロセスが異常終了すると、以降すべての書き込みが永久に詰まる。
    // 別プロセスの pid を書いた古いロックを置いて、奪えることを確認する。
    const lockPath = lock.lockPathFor(target);
    fs.writeFileSync(lockPath, '999999 stale\n');
    const old = Date.now() - 60_000;
    fs.utimesSync(lockPath, new Date(old), new Date(old));

    expect(lock.isStale(lockPath, lock.DEFAULT_STALE_MS)).toBe(true);
    const release = lock.acquire(target); // 奪えるはず
    expect(fs.readFileSync(lockPath, 'utf-8')).toContain(String(process.pid));
    release();
  });

  it('does not treat a fresh lock as stale', () => {
    const lockPath = lock.lockPathFor(target);
    fs.writeFileSync(lockPath, '999999 fresh\n');
    expect(lock.isStale(lockPath, lock.DEFAULT_STALE_MS)).toBe(false);
    fs.unlinkSync(lockPath);
  });
});

describe('timeout', () => {
  it('throws rather than writing without the lock', () => {
    // ロック無しで書き込みを続けると、防ごうとしている lost-update がサイレントに起きる。
    // 静かにデータを失うより明示的に失敗する方がよい。
    const lockPath = lock.lockPathFor(target);
    fs.writeFileSync(lockPath, '999999 held\n'); // 別プロセスが保持中（fresh なので奪えない）
    expect(() => lock.acquire(target, { timeoutPassMs: 60, staleMs: 60_000 }))
      .toThrow(/timed out .* Refusing to write without the lock/s);
    fs.unlinkSync(lockPath);
  });
});

// --- 本命: 実際に複数プロセスを起動して lost-update が起きないことを確認する ---
describe('cross-process mutual exclusion (real child processes)', () => {
  // 子プロセスは同じ fileLock モジュールを使って target を read-modify-write する。
  // ロックが効いていなければ「load → 加算 → write」の系列が競合し、加算が失われる。
  const CHILD = (targetPath, iterations) => `
    const fs = require('fs');
    const { withFileLock } = require(${JSON.stringify(path.resolve(__dirname, '../../src/db/json/fileLock.js'))});
    const target = ${JSON.stringify(targetPath)};
    for (let i = 0; i < ${iterations}; i++) {
      withFileLock(target, () => {
        const rows = JSON.parse(fs.readFileSync(target, 'utf-8'));
        rows.push({ pid: process.pid, i });
        // load と write の間を意図的に広げ、ロックが無ければ確実に競合させる
        const until = Date.now() + 2;
        while (Date.now() < until) { /* spin */ }
        fs.writeFileSync(target, JSON.stringify(rows));
      });
    }
  `;

  it('loses no appends when several processes write concurrently', () => {
    const CHILDREN = 4;
    const ITER = 15;
    fs.writeFileSync(target, '[]');

    const procs = [];
    for (let c = 0; c < CHILDREN; c++) {
      const { spawn } = require('child_process');
      procs.push(spawn(process.execPath, ['-e', CHILD(target, ITER)], { stdio: 'inherit' }));
    }
    // 全子プロセスの終了を同期的に待つ
    const done = procs.map((p) => new Promise((resolve, reject) => {
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
      p.on('error', reject);
    }));

    return Promise.all(done).then(() => {
      const rows = JSON.parse(fs.readFileSync(target, 'utf-8'));
      // ロックが無ければここが CHILDREN*ITER を下回る（後勝ちで消える）
      expect(rows).toHaveLength(CHILDREN * ITER);
      // 各プロセスの書き込みが全て残っていること
      const byPid = new Map();
      for (const r of rows) byPid.set(r.pid, (byPid.get(r.pid) || 0) + 1);
      expect(byPid.size).toBe(CHILDREN);
      for (const count of byPid.values()) expect(count).toBe(ITER);
    });
  }, 30000);

  it('leaves no lock file behind after all processes finish', () => {
    expect(fs.existsSync(lock.lockPathFor(target))).toBe(false);
  });
});
