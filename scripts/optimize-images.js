// 画像圧縮自動化スクリプト（npm run optimize-images で実行）
// imagemin 系は ESM-only のため CJS require では { default: fn } が返る（両形を吸収）
const _imagemin = require('imagemin');
const imagemin = _imagemin.default || _imagemin;
const _mozjpeg = require('imagemin-mozjpeg');
const imageminMozjpeg = _mozjpeg.default || _mozjpeg;
const _pngquant = require('imagemin-pngquant');
const imageminPngquant = _pngquant.default || _pngquant;
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
