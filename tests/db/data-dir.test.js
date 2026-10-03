// src/db/json/data-dir.js — data ディレクトリ解決の chokepoint 契約を固定するテスト。
// STRAWBERRY_DATA_DIR 優先 > Jest ワーカー専用 dir (data-test/worker-N) > data/ の3段解決は、
// ワーカー並列時のロストアップデート防止と永続ボリューム分離の前提。
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveDataDir } = require('../../src/db/json/data-dir');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SAVED = {};

function setEnv(k, v) { if (!(k in SAVED)) SAVED[k] = process.env[k]; process.env[k] = v; }
function delEnv(k) { if (!(k in SAVED)) SAVED[k] = process.env[k]; delete process.env[k]; }
afterEach(() => {
  for (const k of Object.keys(SAVED)) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k];
    delete SAVED[k];
  }
});

describe('resolveDataDir', () => {
  it('honors an absolute STRAWBERRY_DATA_DIR verbatim', () => {
    setEnv('STRAWBERRY_DATA_DIR', '/tmp/custom-data');
    expect(resolveDataDir()).toBe('/tmp/custom-data');
  });

  it('resolves a relative STRAWBERRY_DATA_DIR to an absolute path', () => {
    setEnv('STRAWBERRY_DATA_DIR', 'my-data-dir');
    expect(path.isAbsolute(resolveDataDir())).toBe(true);
    expect(resolveDataDir()).toBe(path.resolve('my-data-dir'));
  });

  it('env override takes precedence over JEST_WORKER_ID', () => {
    setEnv('STRAWBERRY_DATA_DIR', '/tmp/explicit');
    expect(resolveDataDir()).toBe('/tmp/explicit');
    expect(resolveDataDir()).not.toContain('data-test');
  });

  it('falls back to a per-Jest-worker dir under Jest', () => {
    delEnv('STRAWBERRY_DATA_DIR');
    const expected = path.join(REPO_ROOT, 'data-test', `worker-${process.env.JEST_WORKER_ID}`);
    expect(resolveDataDir()).toBe(expected);
  });

  it('falls back to repo-root data/ outside Jest', () => {
    // JEST_WORKER_ID は Jest 配下では必ず設定されるため、子プロセスで検証する。
    const out = execFileSync(process.execPath, [
      '-e', "console.log(require('./src/db/json/data-dir').resolveDataDir())",
    ], { cwd: REPO_ROOT, env: { PATH: process.env.PATH } }).toString().trim();
    expect(out).toBe(path.join(REPO_ROOT, 'data'));
  });
});
