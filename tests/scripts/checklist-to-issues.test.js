// checklist-to-issues の回帰テスト（Octokit はモック）
const fs = require('fs');
const os = require('os');
const path = require('path');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-issues-'));
  jest.resetModules();
});
afterEach(() => {
  delete process.env.CHECKLIST_ISSUES_PATH;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPO;
  fs.rmSync(dir, { recursive: true, force: true });
});

function requireScript() {
  return require('../../scripts/checklist-to-issues');
}

describe('require/設定', () => {
  it('env 未設定でも require でプロセスを殺さない（import 時副作用なし）', () => {
    const mod = requireScript();
    expect(typeof mod.createIssues).toBe('function');
    expect(() => mod.repoCoords()).toThrow(/GITHUB_TOKEN.*GITHUB_REPO/);
  });

  it('GITHUB_REPO が owner/repo 形式でないと拒否する', () => {
    process.env.GITHUB_TOKEN = 't';
    process.env.GITHUB_REPO = 'only-owner';
    expect(() => requireScript().repoCoords()).toThrow(/owner\/repo/);
    process.env.GITHUB_REPO = 'o/r';
    expect(requireScript().repoCoords()).toEqual({ owner: 'o', repo: 'r' });
  });
});

describe('extractChecklistTasks', () => {
  it('チェックリスト不在は明示エラー', () => {
    process.env.CHECKLIST_ISSUES_PATH = path.join(dir, 'missing.md');
    expect(() => requireScript().extractChecklistTasks()).toThrow(/missing\.md.*ありません/);
  });

  it('未完了チェックボックスと【改善案】本文を抽出する', () => {
    const file = path.join(dir, 'cl.md');
    fs.writeFileSync(file, [
      '- [x] 済みタスク',
      '- [ ] タスクA',
      '- 【改善案】A の改善本文',
      '- [ ] タスクB',
      '通常テキスト',
    ].join('\n'));
    process.env.CHECKLIST_ISSUES_PATH = file;
    const tasks = requireScript().extractChecklistTasks();
    expect(tasks).toEqual([
      { title: 'タスクA', body: 'A の改善本文' },
      { title: 'タスクB', body: '' },
    ]);
  });
});

describe('createIssues', () => {
  it('open issue を全ページ舐めて重複作成しない・ラベル用意・作成失敗は個別に継続', async () => {
    const calls = { labels: [], created: [] };
    const fake = {
      paginate: jest.fn(async () => [{ title: '既存タスク' }]),
      issues: {
        createLabel: async ({ name }) => { calls.labels.push(name); },
        create: async ({ title }) => {
          if (title === '落ちる') throw new Error('422 fail');
          calls.created.push(title);
        },
      },
    };
    // @octokit/rest は optionalDependencies かつローカル未導入のため virtual モック
    jest.doMock('@octokit/rest', () => ({ Octokit: function () { return fake; } }), { virtual: true });
    const file = path.join(dir, 'cl.md');
    fs.writeFileSync(file, '- [ ] 既存タスク\n- [ ] 新規A\n- [ ] 落ちる\n- [ ] 新規B\n');
    process.env.CHECKLIST_ISSUES_PATH = file;
    process.env.GITHUB_TOKEN = 't';
    process.env.GITHUB_REPO = 'o/r';

    const { createIssues } = requireScript();
    const res = await createIssues();
    expect(fake.paginate).toHaveBeenCalled();
    expect(calls.labels).toEqual(['improvement', 'auto-generated']);
    expect(calls.created).toEqual(['新規A', '新規B']);
    expect(res).toEqual({ created: 2, skipped: 1, failed: 1 });
  });
});
