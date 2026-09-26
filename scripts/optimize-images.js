// 画像圧縮自動化スクリプト（npm run optimize-images で実行）
const path = require('path');

// imagemin 系はバージョンにより ESM-only（require が { default: fn } の
// 名前空間を返す）— Node 20.19+ の require(esm) で取り込むと関数が
// .default 側に入るため、両形態を正規化する。
function esmInterop(mod) {
  return (mod && mod.default) || mod;
}
const imagemin = esmInterop(require('imagemin'));
const imageminMozjpeg = esmInterop(require('imagemin-mozjpeg'));
const imageminPngquant = esmInterop(require('imagemin-pngquant'));

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
