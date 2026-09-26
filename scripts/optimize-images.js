// 画像圧縮自動化スクリプト（npm run optimize-images で実行）
// imagemin 系はインストール時に脆弱性の高い依存連鎖（decompress/download/tar 等）
// を引き込むため package.json の optionalDependencies から外した。
// 未導入の場合は `npm i --no-save` で一時導入してから実行する（CI ワークフロー
// 側の変更を不要にし、package.json / lockfile も汚染しない）。
const path = require('path');

// imagemin-mozjpeg@10 等は ESM-only — Node 20.19+ の require(esm) は
// { default: fn } 名前空間を返すため、関数本体は .default 側にある。
// CJS/ESM 両形態を正規化する。
function esmInterop(mod) {
  return (mod && mod.default) || mod;
}

function loadImagemin() {
  try {
    return {
      imagemin: esmInterop(require('imagemin')),
      imageminMozjpeg: esmInterop(require('imagemin-mozjpeg')),
      imageminPngquant: esmInterop(require('imagemin-pngquant')),
    };
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    return null;
  }
}

(async () => {
  let mods = loadImagemin();
  if (!mods) {
    console.log('imagemin not installed; installing build-time copy (npm i --no-save) ...');
    try {
      require('child_process').execSync(
        'npm i --no-save imagemin imagemin-mozjpeg imagemin-pngquant',
        { stdio: 'inherit' }
      );
    } catch (_) { /* fallthrough: loadImagemin で再判定 */ }
    mods = loadImagemin();
    if (!mods) {
      console.error('imagemin install failed; cannot optimize images.');
      process.exit(1);
    }
  }
  const { imagemin, imageminMozjpeg, imageminPngquant } = mods;

  const inputDir = path.join(__dirname, '../public/images/*.{jpg,jpeg,png}');
  const outputDir = path.join(__dirname, '../public/images');
  const files = await imagemin([inputDir], {
    destination: outputDir,
    plugins: [
      imageminMozjpeg({ quality: 80 }),
      imageminPngquant({ quality: [0.7, 0.9] })
    ]
  });
  console.log(`Optimized ${files.length} images.`);
})();
