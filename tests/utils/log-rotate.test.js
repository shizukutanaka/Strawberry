// tests/utils/log-rotate.test.js
// appendRotated: 追記ログのサイズ上限ローテーション
//  - 閾値超過で現行ファイルを .1 に退避しディスク使用を 2×maxBytes に収める
//  - 未作成ファイルはそのまま追記（ENOENT をエラーにしない）
//  - ensureLogDir は同一ディレクトリの mkdir を一度だけ行う
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendRotated, ensureLogDir } = require('../../src/utils/log-rotate');

describe('appendRotated', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logrot-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends to a fresh file without error', () => {
    const f = path.join(dir, 'a.log');
    appendRotated(f, 'hello\n');
    expect(fs.readFileSync(f, 'utf-8')).toBe('hello\n');
  });

  it('rotates to .1 when size exceeds maxBytes', () => {
    const f = path.join(dir, 'a.log');
    fs.writeFileSync(f, 'x'.repeat(100));
    appendRotated(f, 'new\n', { maxBytes: 50 });
    expect(fs.readFileSync(f, 'utf-8')).toBe('new\n');
    expect(fs.readFileSync(`${f}.1`, 'utf-8')).toBe('x'.repeat(100));
  });

  it('keeps disk usage bounded to ~2x maxBytes across rotations', () => {
    const f = path.join(dir, 'a.log');
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(f, 'y'.repeat(100));
      appendRotated(f, 'z'.repeat(10), { maxBytes: 50 });
    }
    const total = fs.statSync(f).size + fs.statSync(`${f}.1`).size;
    expect(total).toBeLessThanOrEqual(110 + 50); // .1(100) + current(10)
  });

  it('does not rotate when under the limit', () => {
    const f = path.join(dir, 'a.log');
    appendRotated(f, 'short\n', { maxBytes: 1024 });
    expect(fs.existsSync(`${f}.1`)).toBe(false);
  });

  it('skips rotation when the rotate lock is held by another process', () => {
    const f = path.join(dir, 'a.log');
    fs.writeFileSync(f, 'x'.repeat(100));
    // 他プロセスがローテート中を模してロックを保持
    fs.mkdirSync(`${f}.rotate-lock`);
    appendRotated(f, 'new\n', { maxBytes: 50 });
    // ローテートされず追記のみ行われる（次の書き手がローテートする）
    expect(fs.readFileSync(f, 'utf-8')).toBe('x'.repeat(100) + 'new\n');
    expect(fs.existsSync(`${f}.1`)).toBe(false);
    expect(fs.existsSync(`${f}.rotate-lock`)).toBe(true);
  });

  it('reclaims a stale lock and rotates normally', () => {
    const f = path.join(dir, 'a.log');
    fs.writeFileSync(f, 'x'.repeat(100));
    // クラッシュ残留の古いロックを再現（mtime を 1 分前に偽装）
    fs.mkdirSync(`${f}.rotate-lock`);
    const old = Date.now() - 60 * 1000;
    fs.utimesSync(`${f}.rotate-lock`, new Date(old), new Date(old));
    appendRotated(f, 'new\n', { maxBytes: 50 });
    expect(fs.readFileSync(f, 'utf-8')).toBe('new\n');
    expect(fs.readFileSync(`${f}.1`, 'utf-8')).toBe('x'.repeat(100));
    expect(fs.existsSync(`${f}.rotate-lock`)).toBe(false);
  });
});

describe('ensureLogDir', () => {
  it('creates the directory once and caches it', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'logdir-'));
    const f = path.join(d, 'sub', 'x.log');
    const spy = jest.spyOn(fs, 'mkdirSync');
    ensureLogDir(f);
    ensureLogDir(f);
    ensureLogDir(f);
    const calls = spy.mock.calls.filter(c => String(c[0]).includes('logdir-'));
    expect(calls.length).toBe(1);
    spy.mockRestore();
    fs.rmSync(d, { recursive: true, force: true });
  });
});
