// 画像圧縮自動化スクリプト（npm run optimize-images で実行）
// imagemin 系はインストール時に脆弱性の高い依存連鎖（decompress/download/tar 等）
// を引き込むため package.json の optionalDependencies から外した。
// このスクリプトを使う場合は事前に:
//   npm i --no-save imagemin imagemin-mozjpeg imagemin-pngquant
const imagemin = require('imagemin');
const imageminMozjpeg = require('imagemin-mozjpeg');
const imageminPngquant = require('imagemin-pngquant');
const path = require('path');

(async () => {
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
