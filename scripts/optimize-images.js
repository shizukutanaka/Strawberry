// 画像圧縮自動化スクリプト（npm run optimize-images で実行）
// imagemin 系 v10+ は ESM-only。Node 20.19+/22/24 の require(ESM) は
// { default: fn } 名前空間を返すため default へのフォールバックが必要。
function esmInterop(mod) { return (mod && mod.default) || mod; }
const imagemin = esmInterop(require('imagemin'));
const imageminMozjpeg = esmInterop(require('imagemin-mozjpeg'));
const imageminPngquant = esmInterop(require('imagemin-pngquant'));
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
