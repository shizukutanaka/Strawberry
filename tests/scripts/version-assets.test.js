// version-assets.js / update-references.js の回帰テスト
// 旧実装の3欠陥をカバー: サブディレクトリ非再帰・非冪等な二重ハッシュ・
// 境界なし部分一致による参照破壊（myapp.js → myapp.<hash>.js の誤生成）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { versionAssets } = require('../../scripts/version-assets');
const { updateReferences, getVersionedMap } = require('../../scripts/update-references');

let root;
function write(rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function listAll(dir = root, base = '', acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) listAll(path.join(dir, e.name), rel, acc);
    else acc.push(rel);
  }
  return acc;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vassets-'));
  console.log = jest.fn(); // スクリプトの進行ログを静粛化
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('version-assets', () => {
  it('サブディレクトリ（js/, css/）配下のアセットもハッシュ付きコピーを生成する', () => {
    write('js/app.js', 'x=1');
    write('css/app.css', 'body{}');
    versionAssets(root);
    const files = listAll();
    expect(files.some(f => /^js\/app\.[0-9a-f]{8}\.js$/.test(f))).toBe(true);
    expect(files.some(f => /^css\/app\.[0-9a-f]{8}\.css$/.test(f))).toBe(true);
  });

  it('冪等: 再実行しても .<hash>.<hash> の二重付与や残骸が増えない', () => {
    write('js/app.js', 'x=1');
    versionAssets(root);
    versionAssets(root);
    versionAssets(root);
    const files = listAll();
    expect(files.filter(f => f.includes('app.'))).toHaveLength(2); // app.js + app.<hash>.js
    expect(files.some(f => /\.[0-9a-f]{8}\.[0-9a-f]{8}\./.test(f))).toBe(false);
  });

  it('内容変更で新ハッシュを生成し、同一ベースの旧ハッシュファイルを掃除する', () => {
    write('js/app.js', 'x=1');
    versionAssets(root);
    write('js/app.js', 'x=2'); // 内容変更 → 別ハッシュ
    versionAssets(root);
    const versioned = listAll().filter(f => /^js\/app\.[0-9a-f]{8}\.js$/.test(f));
    expect(versioned).toHaveLength(1); // 旧版が残らない
  });
});

describe('update-references', () => {
  it('HTML 内の参照をハッシュ付き名へ書き換える（サブディレクトリ含む）', () => {
    write('js/app.js', 'x=1');
    write('index.html', '<script src="/js/app.js"></script>');
    versionAssets(root);
    updateReferences(root);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    expect(html).toMatch(/<script src="\/js\/app\.[0-9a-f]{8}\.js"><\/script>/);
  });

  it('部分一致で他ファイル参照を壊さない: myapp.js は app.js のハッシュに汚染されない', () => {
    write('top.js', 'z=1');
    write('mytop.js', 'm=1');
    write('index.html', '<script src="top.js"></script><script src="mytop.js"></script>');
    versionAssets(root);
    updateReferences(root);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const map = getVersionedMap(root);
    // top.js と mytop.js はそれぞれ「自分の」ハッシュ付き名に置き換わる
    expect(html).toContain(`"${map['top.js']}"`);
    expect(html).toContain(`"${map['mytop.js']}"`);
    // 旧バグでは mytop.js が top.js のハッシュに書き換えられた
    expect(html).not.toContain('mytop' + map['top.js'].slice(map['top.js'].indexOf('.')));
  });

  it('バージョン付きファイルが無ければ HTML は無変更', () => {
    write('index.html', '<script src="/js/app.js"></script>');
    updateReferences(root);
    expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8'))
      .toBe('<script src="/js/app.js"></script>');
  });
});
