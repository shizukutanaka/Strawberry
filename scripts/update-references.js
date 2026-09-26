// index.html等の静的ファイル参照を最新バージョンファイル名に自動置換
//
// version-assets.js が生成した `<base>.<8hex>.<ext>` ファイルを public/ 以下から
// 再帰的に収集し、HTML 内の参照（`src="..."`, `href="..."`）を書き換える。
//
// 旧実装の欠陥:
//  - 1 階層しか走査せず js/・css/ 配下の実資産を見つけられなかった
//  - `new RegExp(orig.replace('.', '\.'))` は最初のドットしかエスケープせず、
//    さらに境界ガードがなかったため、`top.js` のパターンが `mytop.js` に
//    部分一致して `mytop.302795e1.js` という存在しない参照を書き込んでいた
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '../public');
const exts = ['.js', '.css', '.png', '.jpg', '.jpeg', '.svg'];
const VERSIONED_RE = /^(.+?)\.([0-9a-f]{8})\.(js|css|png|jpg|jpeg|svg)$/i;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// public/ 配下を再帰的に走査し、ファイル名を収集する。
function walk(dir, base, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(full, rel, acc);
    else acc.push({ name: entry.name, rel });
  }
  return acc;
}

// バージョン付きファイル名のマッピングを作成。
// キーは public/ からの相対パス（`js/app.js`）で、ベース名が一意なものだけは
// 短い形（`app.js`）のキーも追加する（`src="app.js"` 形式の参照用）。
function getVersionedMap(dir) {
  const files = walk(dir, '');
  const map = {};
  const byBaseName = {}; // basename -> [versioned rel paths]
  for (const f of files) {
    const m = f.rel.match(VERSIONED_RE);
    if (!m) continue;
    const base = `${m[1]}.${m[3]}`;
    map[base] = f.rel;
    const baseName = `${path.basename(m[1])}.${m[3]}`;
    (byBaseName[baseName] = byBaseName[baseName] || []).push(f.rel);
  }
  for (const [baseName, rels] of Object.entries(byBaseName)) {
    if (rels.length === 1 && !map[baseName]) map[baseName] = rels[0];
  }
  return map;
}

function updateReferences(rootDir = publicDir) {
  const htmlFiles = walk(rootDir, '').filter(f => f.name.endsWith('.html'));
  const versionedMap = getVersionedMap(rootDir);

  htmlFiles.forEach(({ rel }) => {
    const htmlPath = path.join(rootDir, rel);
    let html = fs.readFileSync(htmlPath, 'utf8');
    Object.entries(versionedMap).forEach(([orig, hashed]) => {
      // 直前の文字が URL/属性の境界（先頭, 引用符, (, /, =, 空白）のときだけ置換する。
      // これにより `myapp.js` 内の `app.js` への誤マッチを防ぐ（直前の y は単語文字）。
      const re = new RegExp(`(^|[\\s"'(/=])${escapeRegExp(orig)}`, 'g');
      html = html.replace(re, (m, p1) => p1 + hashed);
    });
    fs.writeFileSync(htmlPath, html);
    console.log(`Updated references in ${rel}`);
  });
}

if (require.main === module) {
  updateReferences();
}

module.exports = { updateReferences, getVersionedMap };
