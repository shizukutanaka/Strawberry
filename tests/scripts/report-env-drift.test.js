// tests/scripts/report-env-drift.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { report } = require('../../scripts/report-env-drift');

// 最小リポジトリ構造を tmp に作る: src/scripts/tests + .env.example
function makeRepo({ files = {}, envExample = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envdrift-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const envPath = path.join(dir, '.env.example');
  fs.writeFileSync(envPath, envExample);
  return { dir, envPath };
}

describe('report-env-drift', () => {
  let dir;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('コード参照済み・記載済みなら drift なし', () => {
    const repo = makeRepo({
      files: { 'src/app.js': 'const x = process.env.MY_FLAG;' },
      envExample: 'MY_FLAG=\n',
    });
    dir = repo.dir;
    const r = report(repo.dir, repo.envPath);
    expect(r.undocumented).toHaveLength(0);
    expect(r.unreferenced).toHaveLength(0);
  });

  it('コードが参照するが .env.example 未記載の変数を undocumented に出す', () => {
    const repo = makeRepo({
      files: { 'src/a.js': 'process.env.SECRET_X;' },
      envExample: 'OTHER=\n',
    });
    dir = repo.dir;
    const r = report(repo.dir, repo.envPath);
    expect(r.undocumented.map((u) => u.name)).toEqual(['SECRET_X']);
    expect(r.undocumented[0].references[0]).toMatch(/^src\/a\.js:1$/);
  });

  it('記載のみでコードに一切出ない変数を unreferenced に出す', () => {
    const repo = makeRepo({
      files: { 'src/a.js': 'process.env.USED;' },
      envExample: 'USED=\nSTALE_VAR=\n',
    });
    dir = repo.dir;
    const r = report(repo.dir, repo.envPath);
    expect(r.unreferenced).toEqual(['STALE_VAR']);
  });

  it('env.NAME 経由とブラケット記法も参照として拾う', () => {
    const repo = makeRepo({
      files: {
        'src/a.js': "function f(env = process.env) { return env.VIA_ENV + process.env['VIA_BRACKET']; }",
      },
      envExample: 'VIA_ENV=\nVIA_BRACKET=\n',
    });
    dir = repo.dir;
    const r = report(repo.dir, repo.envPath);
    expect(r.undocumented).toHaveLength(0);
  });

  it('コメント行内の process.env.X は参照とみなさない', () => {
    const repo = makeRepo({
      files: { 'src/a.js': '// process.env.DOC_ONLY を設定する\nconst a = 1;' },
      envExample: 'DOC_ONLY=\n',
    });
    dir = repo.dir;
    const r = report(repo.dir, repo.envPath);
    // DOC_ONLY は未記載扱いでなく unreferenced 側にも出ない（文字列としては存在）
    expect(r.undocumented).toHaveLength(0);
    expect(r.unreferenced).toHaveLength(0);
  });

  it('組み込み変数（NODE_ENV 等）は undocumented に出さない', () => {
    const repo = makeRepo({
      files: { 'src/a.js': 'if (process.env.NODE_ENV === "test") {}' },
      envExample: '',
    });
    dir = repo.dir;
    const r = report(repo.dir, repo.envPath);
    expect(r.undocumented).toHaveLength(0);
  });

  it('tests/ 内でしか出ない変数は unreferenced に出さない', () => {
    const repo = makeRepo({
      files: { 'tests/x.test.js': 'process.env.E2E_TOKEN;' },
      envExample: 'E2E_TOKEN=\n',
    });
    dir = repo.dir;
    const r = report(repo.dir, repo.envPath);
    expect(r.unreferenced).toHaveLength(0);
  });

  it('ルート直下 *.js の参照もスキャン対象（undocumented/haystack 両方）', () => {
    const repo = makeRepo({
      files: {
        'tool.js': 'process.env.ROOT_VAR; process.env.ONLY_DOC;',
        'src/a.js': 'process.env.MY_FLAG;',
      },
      envExample: 'MY_FLAG=\nONLY_DOC=\n',
    });
    dir = repo.dir;
    const r = report(repo.dir, repo.envPath);
    // ルート *.js の参照は undocumented 検出対象
    expect(r.undocumented.map((u) => u.name)).toContain('ROOT_VAR');
    // ルート *.js に出る変数は unreferenced に出さない（haystack 側も効く）
    expect(r.unreferenced).not.toContain('ONLY_DOC');
  });

  it('.env.example 内の重複記載を duplicates に出す', () => {
    const repo = makeRepo({
      files: { 'src/a.js': 'process.env.MY_FLAG;' },
      envExample: 'MY_FLAG=\nOTHER=\nMY_FLAG=1\n',
    });
    dir = repo.dir;
    const r = report(repo.dir, repo.envPath);
    expect(r.duplicates).toEqual(['MY_FLAG']);
  });
});
