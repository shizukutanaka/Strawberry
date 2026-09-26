// tests/scripts/script-deps.test.js
// scripts/*.js が require する外部パッケージが package.json に宣言されていること、
// および各スクリプトが設定未投入時に「Cannot find module」のスタックではなく
// 設定手順の分かるエラーで止まることを保証する回帰テスト。
//
// 背景: progress-report / *-to-sheets / *-to-notion / checklist-to-issues /
// slack-notify-graph / kpi-trend-graph / sample が googleapis・@notionhq/client・
// @octokit/rest・@slack/web-api・chartjs-node-canvas・i18next を package.json 未宣言の
// まま require しており、`npm run <script>` が即座にクラッシュしていた。
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '../..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const pkg = require(path.join(ROOT, 'package.json'));

const DECLARED = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
]);

// 意図的に未宣言の外部モジュール（呼び出し側が absence を吸収する設計のもの）。
// @sentry/node: service-monitor.js が lazy require + try/catch でガード済み
// （probe57 で固定）。宣言すると ~30MB の重い依存が全インストールに混入する。
const INTENTIONALLY_OPTIONAL = new Set(['@sentry/node']);

function bareSpecifier(spec) {
  return spec.startsWith('@')
    ? spec.split('/').slice(0, 2).join('/')
    : spec.split('/')[0];
}

describe('scripts/ の外部依存が package.json に宣言されている', () => {
  const scriptFiles = fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.js'));

  test('スクリプトが存在する（サニティ）', () => {
    expect(scriptFiles.length).toBeGreaterThan(10);
  });

  for (const file of scriptFiles) {
    test(`${file}: 全 bare require が宣言済み`, () => {
      const src = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
      const specs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
      const missing = [];
      for (const spec of specs) {
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
        if (Module.builtinModules.includes(spec)) continue;
        const bare = bareSpecifier(spec);
        if (!DECLARED.has(bare) && !INTENTIONALLY_OPTIONAL.has(bare)) {
          missing.push(bare);
        }
      }
      expect(missing).toEqual([]);
    });
  }

  test('宣言された外部依存が実際に解決できる', () => {
    for (const dep of ['googleapis', '@notionhq/client', '@octokit/rest', '@slack/web-api', 'chartjs-node-canvas', 'i18next', 'i18next-fs-backend']) {
      expect(() => require.resolve(dep, { paths: [ROOT] })).not.toThrow();
    }
  });
});

describe('設定未投入時に分かりやすいエラーで止まる', () => {
  const envBackup = { ...process.env };
  afterEach(() => { process.env = { ...envBackup }; });

  test('google-sheets-auth: credentials.json 未配置で手順付きエラー', async () => {
    const { authorize } = require('../../scripts/google-sheets-auth');
    await expect(authorize('/nonexistent/credentials.json', '/nonexistent/token.json'))
      .rejects.toThrow(/credentials\.json.*がありません/);
  });

  test('google-sheets-auth: 不正な credentials 形式で手順付きエラー', async () => {
    const { authorize } = require('../../scripts/google-sheets-auth');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gauth-'));
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ bogus: true }));
    fs.writeFileSync(path.join(dir, 'token.json'), '{}');
    await expect(authorize(path.join(dir, 'credentials.json'), path.join(dir, 'token.json')))
      .rejects.toThrow(/形式が不正/);
  });

  test('progress-report: PROGRESS_SHEET_ID 未設定で明示エラー', async () => {
    delete process.env.PROGRESS_SHEET_ID;
    jest.resetModules();
    const { main } = require('../../scripts/progress-report.js');
    await expect(main()).rejects.toThrow(/PROGRESS_SHEET_ID/);
  });

  test('notion-progress-report / priority-to-notion: NOTION_* 未設定で明示エラー', async () => {
    delete process.env.NOTION_TOKEN;
    delete process.env.NOTION_DB_ID;
    jest.resetModules();
    await expect(require('../../scripts/notion-progress-report.js').main())
      .rejects.toThrow(/NOTION_TOKEN/);
    jest.resetModules();
    await expect(require('../../scripts/priority-to-notion.js').main())
      .rejects.toThrow(/NOTION_TOKEN/);
  });
});
