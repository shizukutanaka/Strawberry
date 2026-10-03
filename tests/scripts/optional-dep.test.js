// tests/scripts/optional-dep.test.js
// scripts/lib/optional-dep.js と、optionalDependencies を遅延 require する
// スクリプト群の契約を固定する回帰テスト。
//
// 背景: google-sheets-auth / *-to-sheets / progress-report / *-to-notion /
// slack-notify-graph が googleapis・@notionhq/client・@slack/web-api を
// トップレベル require しており、npm が engines/プラットフォーム不一致で
// optionalDependencies をスキップした環境では MODULE_NOT_FOUND のスタックだけが
// 出て対処手順が分からなかった（script-deps テスト整備時の残存分）。
const fs = require('fs');
const path = require('path');
const { requireOptional } = require('../../scripts/lib/optional-dep');

const SCRIPTS_DIR = path.join(__dirname, '../../scripts');

describe('requireOptional', () => {
  test('導入済みモジュールはそのまま返す', () => {
    expect(requireOptional('fs')).toBe(require('fs'));
    expect(requireOptional('path')).toBe(require('path'));
  });

  test('未導入の optional dep は導入手順付きエラーを投げる', () => {
    expect(() => requireOptional('@definitely-not-installed/strawberry-test-pkg'))
      .toThrow(/@definitely-not-installed\/strawberry-test-pkg が未導入です/);
    expect(() => requireOptional('@definitely-not-installed/strawberry-test-pkg'))
      .toThrow(/npm i @definitely-not-installed\/strawberry-test-pkg/);
  });

  test('MODULE_NOT_FOUND 以外の内部エラーはそのまま伝播する', () => {
    const tmp = path.join(require('os').tmpdir(), `optional-dep-throw-${process.pid}.js`);
    fs.writeFileSync(tmp, "throw new Error('internal failure');");
    try {
      expect(() => requireOptional(tmp)).toThrow('internal failure');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('optional dep を遅延 require するスクリプト', () => {
  const CASES = [
    ['google-sheets-auth.js', 'googleapis'],
    ['feedback-to-sheets.js', 'googleapis'],
    ['priority-to-sheets.js', 'googleapis'],
    ['progress-report.js', 'googleapis'],
    ['notion-progress-report.js', '@notionhq/client'],
    ['priority-to-notion.js', '@notionhq/client'],
    ['slack-notify-graph.js', '@slack/web-api'],
  ];
  for (const [file, spec] of CASES) {
    test(`${file}: 裸の require('${spec}') を持たず requireOptional 経由`, () => {
      const src = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
      // requireOptional(...) 経由のみを許容（裸 require だと MODULE_NOT_FOUND が露出する）
      expect(src).not.toContain(`require('${spec}')`);
      expect(src).not.toContain(`require("${spec}")`);
      expect(src).toContain(`requireOptional('${spec}')`);
    });
  }
});
