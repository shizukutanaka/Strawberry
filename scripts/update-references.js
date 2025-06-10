// index.html等の静的ファイル参照を最新バージョンファイル名に自動置換
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '../public');
const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
const exts = ['.js', '.css', '.png', '.jpg', '.jpeg', '.svg'];

// バージョン付きファイル名のマッピングを作成
function getVersionedMap(dir) {
  const map = {};
  fs.readdirSync(dir).forEach(file => {
    const m = file.match(/(.+?)\.(\w{8})\.(js|css|png|jpg|jpeg|svg)$/);
    if (m) {
      const base = `${m[1]}.${m[3]}`;
      map[base] = file;
    }
  });
  return map;
}

const versionedMap = getVersionedMap(publicDir);

htmlFiles.forEach(htmlFile => {
  const htmlPath = path.join(publicDir, htmlFile);
  let html = fs.readFileSync(htmlPath, 'utf8');
  Object.entries(versionedMap).forEach(([orig, hashed]) => {
    // 参照を書き換え
    html = html.replace(new RegExp(orig.replace('.', '\.'), 'g'), hashed);
  });
  fs.writeFileSync(htmlPath, html);
  console.log(`Updated references in ${htmlFile}`);
});
