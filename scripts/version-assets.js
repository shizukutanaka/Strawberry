// 静的ファイル自動バージョニング（ハッシュ付きファイル名）スクリプト
//
// public/ 配下のアセットを再帰的に走査し、内容ハッシュ付きのコピー
// （例: js/app.js → js/app.1a2b3c4d.js）を生成する。update-references.js と
// セットで fingerprinting キャッシュバスティングを構成する（#47 の immutable
// Cache-Control 方針はこのハッシュ名の存在を前提とする）。
//
// 旧実装の欠陥:
//  - fs.readdirSync の結果を 1 階層しか見ず public/js・public/css 配下の
//    実資産を一切処理しなかった（パイプライン全体が無音の no-op だった）
//  - 既にハッシュ済みの `<base>.<hash>.<ext>` を再処理し、実行のたびに
//    `.hash` が二重三重に連なるファイルが無制限に蓄積した
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const targetDir = path.join(__dirname, '../public');
const exts = ['.js', '.css', '.png', '.jpg', '.jpeg', '.svg'];
// 既にバージョン付きのファイル名（<base>.<8hex>.<ext>）
const VERSIONED_RE = /\.[0-9a-f]{8}\.(js|css|png|jpg|jpeg|svg)$/i;

function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(data).digest('hex').slice(0, 8);
}

function versionAssets(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      versionAssets(fullPath); // js/・css/ などサブディレクトリを再帰的に処理
      continue;
    }
    const ext = path.extname(entry.name);
    if (!exts.includes(ext)) continue;
    if (VERSIONED_RE.test(entry.name)) continue; // 既バージョン済みはスキップ（冪等性）

    const hash = hashFile(fullPath);
    const base = entry.name.slice(0, -ext.length);
    const newName = `${base}.${hash}${ext}`;
    const newPath = path.join(dir, newName);
    fs.copyFileSync(fullPath, newPath);

    // 同一ベースの旧バージョンファイルを掃除（再実行時の蓄積を防止）。
    // 内容が変わらなければハッシュは同一で newName === 既存名 → このループは何もしない。
    const staleRe = new RegExp(
      `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]{8}${ext.replace('.', '\\.')}$`,
      'i'
    );
    for (const sibling of fs.readdirSync(dir)) {
      if (sibling !== newName && staleRe.test(sibling)) {
        fs.unlinkSync(path.join(dir, sibling));
      }
    }
    console.log(`${path.relative(targetDir, fullPath)} → ${path.relative(targetDir, newPath)}`);
  }
}

if (require.main === module) {
  versionAssets(targetDir);
}

module.exports = { versionAssets, hashFile, VERSIONED_RE };
