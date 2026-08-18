// index.html等の静的ファイル参照を最新バージョンファイル名に自動置換
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '../public');
const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
const _exts = ['.js', '.css', '.png', '.jpg', '.jpeg', '.svg'];

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
    // 通常文字列の '\.' は '.' に潰れるため、生成される正規表現ではドットが
    // 「任意の1文字」になっていた（意図はリテラルのドット）。さらに置換対象の
    // ファイル名にはドット以外の正規表現メタ文字も入りうるので、全体をエスケープする。
    const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escaped, 'g'), hashed);
  });
  fs.writeFileSync(htmlPath, html);
  console.log(`Updated references in ${htmlFile}`);
});
