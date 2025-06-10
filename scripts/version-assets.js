// 静的ファイル自動バージョニング（ハッシュ付きファイル名）スクリプト
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const targetDir = path.join(__dirname, '../public');
const exts = ['.js', '.css', '.png', '.jpg', '.jpeg', '.svg'];

function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(data).digest('hex').slice(0, 8);
}

function versionAssets(dir) {
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) return;
    const ext = path.extname(file);
    if (!exts.includes(ext)) return;
    const hash = hashFile(fullPath);
    const newName = file.replace(ext, `.${hash}${ext}`);
    const newPath = path.join(dir, newName);
    fs.copyFileSync(fullPath, newPath);
    console.log(`${file} → ${newName}`);
  });
}

versionAssets(targetDir);
