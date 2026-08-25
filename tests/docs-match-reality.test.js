// tests/docs-match-reality.test.js
// ドキュメントが主張していることと、実際のコードを機械的に突き合わせる。
//
// このセッションで手作業で見つけた乖離だけでも:
//   - 仕様書が「残るは OTS への root 実提出のみ」と書いていたが、アンカラー自体が
//     どこからも呼ばれていなかった
//   - 仕様書が POST /marketplace/auction を ✅ 実装済みとしていたが、この製品に
//     入札という概念は無く、入札内容は呼び出し側が捏造できた
//   - README が「P2P」「分散型」「Ed25519 ピアIDによる信頼性担保」を掲げていたが、
//     P2P レイヤは読み込みにすら失敗していた
//   - 研究ドキュメントが削除済みモジュールを「拡張元」として名指ししていた
//   - 仕様書の実装済みモジュール一覧に、追加したモジュールを書き忘れていた（自分のミス）
//
// 人が書いた説明は放っておくと必ず実態から離れる。**主張が機械的に検証できる形で
// 書かれている部分だけでも自動で照合する**ことで、次の乖離を早く見つける。
// ここで検査するのは 2 種類:
//   1. 仕様書のエンドポイント表に載っているパスが実際に登録されていること
//   2. 「実装済みの再利用可能モジュール」一覧のファイルが実在すること
const fs = require('fs');
const path = require('path');
const { app } = require('./../src/api/server');

const SPEC = path.join(__dirname, '../docs/SPECIFICATION.md');
const spec = fs.readFileSync(SPEC, 'utf-8');

/** 登録済みルートを "METHOD /path" の集合として取り出す。 */
function registeredRoutes() {
  const out = new Set();
  function walk(stack, prefix) {
    for (const l of stack) {
      if (l.route) {
        for (const m of Object.keys(l.route.methods)) out.add(`${m.toUpperCase()} ${prefix}${l.route.path}`);
      } else if (l.name === 'router' && l.handle && l.handle.stack) {
        let seg = '';
        if (l.regexp && l.regexp.source !== '^\\/?(?=\\/|$)') {
          seg = l.regexp.source.replace('^\\/', '/').replace('\\/?(?=\\/|$)', '')
            .replace(/\\\//g, '/').replace(/\$$/, '');
        }
        walk(l.handle.stack, prefix + seg);
      }
    }
  }
  walk(app._router.stack, '');
  return out;
}

/** 仕様書のエンドポイント表から `/api/...` のパスを抜き出す。 */
function documentedPaths() {
  const paths = new Set();
  for (const line of spec.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const m of line.matchAll(/`(\/api\/[^`]+)`/g)) {
      // 「`/api/v1/gpus`, `/gpus/:id`」のような列挙・クエリ・省略記号を落とす
      let p = m[1].split('?')[0].trim();
      // 「`/api/v1/payments/...`」のような総称表記は個別の主張ではないので除外
      if (p.includes('…') || p.includes('...') || p.includes('*')) continue;
      paths.add(p);
    }
  }
  return [...paths];
}

/** ルート表に、そのパスに対する登録が 1 つでもあるか（メソッドは問わない）。 */
function isRegistered(routes, docPath) {
  const norm = (p) => p.replace(/\/+$/, '');
  const target = norm(docPath);
  for (const r of routes) {
    const p = norm(r.slice(r.indexOf(' ') + 1));
    if (p === target) return true;
    if (p.includes('*')) continue; // catch-all は照合対象にしない
    // 仕様書は :id 等のパラメータ名を実装と違う名前で書くことがある。
    // 正規表現に組み立てる前にメタ文字を必ずエスケープする
    // （素で組み立てて `GET *` に当たり、正規表現の構文エラーで落ちた）。
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp('^' + escaped.replace(/:[A-Za-z]+/g, ':[A-Za-z]+') + '$');
    if (rx.test(target)) return true;
  }
  return false;
}

describe('the endpoint table in docs/SPECIFICATION.md', () => {
  it('lists at least a dozen endpoints (guard against an empty parse)', () => {
    // 抽出が壊れて 0 件になると「全部一致」で緑になってしまう。
    expect(documentedPaths().length).toBeGreaterThan(12);
  });

  it('documents no endpoint that is not actually registered', () => {
    const routes = registeredRoutes();
    const missing = documentedPaths().filter((p) => !isRegistered(routes, p));
    // 仕様書に載っているのに実装が無い＝読者を騙している状態。
    expect(missing).toEqual([]);
  });
});

describe('the module inventory in docs/SPECIFICATION.md', () => {
  const claimed = [...spec.matchAll(/^- `(src\/[^`]+\.js)`/gm)].map((m) => m[1]);

  it('lists a meaningful number of modules (guard against an empty parse)', () => {
    expect(claimed.length).toBeGreaterThan(10);
  });

  it('claims no module that does not exist on disk', () => {
    // 削除したモジュールを一覧に残したままにすると、次の読者がそれを探しに行く。
    const gone = claimed.filter((f) => !fs.existsSync(path.join(__dirname, '..', f)));
    expect(gone).toEqual([]);
  });

  it('also lists every module referenced inline in the same document', () => {
    // 本文中で `src/...js` に言及しているのに、そのファイルが無いケースを拾う。
    const inline = [...spec.matchAll(/`(src\/[a-zA-Z0-9_\-/]+\.js)`/g)].map((m) => m[1]);
    const gone = [...new Set(inline)].filter((f) => !fs.existsSync(path.join(__dirname, '..', f)));
    expect(gone).toEqual([]);
  });
});

describe('README and ARCHITECTURE reference only files that exist', () => {
  it.each(['README.md', 'ARCHITECTURE.md', 'SPECIFICATION.md'])('%s', (docName) => {
    const text = fs.readFileSync(path.join(__dirname, '..', docName), 'utf-8');
    const refs = [...text.matchAll(/`(src\/[a-zA-Z0-9_\-/]+\.js)`/g)].map((m) => m[1]);
    const gone = [...new Set(refs)].filter((f) => !fs.existsSync(path.join(__dirname, '..', f)));
    expect(gone).toEqual([]);
  });
});
