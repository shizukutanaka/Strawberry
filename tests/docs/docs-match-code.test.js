// tests/docs/docs-match-code.test.js
// ドキュメントが**実在しないコードや API を指していない**ことを機械的に保証する。
//
// このリポジトリでは「仕様書が実装より先行している／削除済みのものを実装済みと
// 書いている」問題が繰り返し起きた。実例:
//   - `POST /api/v1/marketplace/auction` を「✅ 実装済」と記載（実際は削除済み）
//   - `src/gpu/gpu-auto-recovery.js` を「拡張元」として名指し（削除済み）
//   - `scripts/slack-notify.js` / `improvement_checklist2.md` への参照（削除済み）
//   - 「P2Pノード運用・スケールアウト」章（そんな構成は存在しない）
// 人が読み比べて直すやり方は、次に何かを消したときにまた漏れる。
//
// ここで検査するのは 2 点だけ。どちらも「書いてあるものが在るか」という機械的な事実:
//   1. 本文中の `src/...` `scripts/...` などのファイルパスが実在すること
//   2. 本文中の `/api/v1/...` パスがルータに登録されていること
// 「書いていないものが在る」（未文書化 API）はここでは扱わない。
const fs = require('fs');
const path = require('path');
const { app } = require('../../src/api/server');

const ROOT = path.resolve(__dirname, '../..');
const DOCS = ['README.md', 'ARCHITECTURE.md', 'SPECIFICATION.md', 'docs/SPECIFICATION.md']
  .map((f) => path.join(ROOT, f))
  .filter((f) => fs.existsSync(f));

function readDocs() {
  return DOCS.map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf-8') }));
}

/** ルータスタックから登録済みパスを集める（メソッドは問わない）。 */
function registeredPaths() {
  const out = new Set();
  (function walk(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        out.add((prefix + layer.route.path).replace(/\/$/, '') || '/');
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        let p = '';
        if (layer.regexp && layer.regexp.source !== '^\\/?(?=\\/|$)') {
          p = layer.regexp.source
            .replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/')
            .replace('(?=\\/|$)', '').replace(/\$$/, '').replace(/\?$/, '');
        }
        walk(layer.handle.stack, prefix + p);
      }
    }
  })(app._router.stack, '');
  return out;
}

/** `/api/v1/gpus/:id` → 正規表現。ドキュメント側の `{root}` `:id` 等の表記ゆれを吸収する。 */
function pathMatcher(registered) {
  const patterns = [...registered].map((r) => new RegExp(
    '^' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+') + '$'
  ));
  return (candidate) => patterns.some((re) => re.test(candidate));
}

describe('documented file paths exist', () => {
  it('finds documentation to check', () => {
    expect(DOCS.length).toBeGreaterThan(0);
  });

  it('references no source file that has been deleted', () => {
    // バックティックで囲まれた src/... scripts/... tests/... のみを対象にする
    // （散文中の語をパスと誤認しないため）。
    //
    // 例外: **同じ行が「削除した」と明言している場合**は許す。経緯の説明として
    // 消したファイル名を書くのは正当で、むしろ書かない方が読み手に不親切
    // （なぜ消したかが辿れなくなる）。許すのは「消したと書いてある」場合だけで、
    // 実装済みとして参照している場合は落とす。
    const REMOVED_MARKER = /削除|廃止|撤去|removed|deleted/i;
    const missing = [];
    for (const { file, text } of readDocs()) {
      for (const line of text.split('\n')) {
        for (const m of line.matchAll(/`((?:src|scripts|tests|public)\/[A-Za-z0-9_\-./]+\.js)`/g)) {
          const rel = m[1];
          if (fs.existsSync(path.join(ROOT, rel))) continue;
          if (REMOVED_MARKER.test(line)) continue;
          missing.push(`${file}: ${rel}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('documented API paths are actually registered', () => {
  it('references no endpoint that does not exist', () => {
    const matches = pathMatcher(registeredPaths());
    const missing = [];
    for (const { file, text } of readDocs()) {
      for (const m of text.matchAll(/`?(\/api\/v1\/[A-Za-z0-9_\-:/{}]+)`?/g)) {
        // 直後が `.`（.../...）や `*`（/escrow/*）なら、それは個別のパスではなく
        // 「この配下」を指す概括的な表記なので検査しない。
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 3);
        const truncated = m[1].endsWith('/') || /^[.*]/.test(after);
        if (truncated) continue;
        const p = m[1]
          .replace(/[`,.)】]+$/, '')
          .replace(/\{(\w+)\}/g, ':$1')   // /{root} → /:root
          .replace(/\/$/, '');
        if (!p || p.endsWith('*') || p.includes('...')) continue;
        if (!matches(p)) missing.push(`${file}: ${p}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
