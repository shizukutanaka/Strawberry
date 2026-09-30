// i18next 多言語デモスクリプト（npm scripts 未登録の参考実装）
// i18next / i18next-fs-backend は package.json に未宣言の任意依存のため、
// トップレベル require では未インストール環境で MODULE_NOT_FOUND により即死する。
// 遅延 require にし、未導入時は導入手順を案内して終了する。
const path = require('path');
const config = require('./config');

// i18next でデモメッセージを初期化・表示する。
// @returns {Promise<boolean>} 実行成功なら true。任意依存未導入や初期化失敗では
//   案内を表示して false を返す（ライブラリ的利用でプロセスを落とさないため）。
async function runI18nSample() {
  let i18next;
  let Backend;
  try {
    i18next = require('i18next');
    Backend = require('i18next-fs-backend');
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.error(
        'i18next / i18next-fs-backend がインストールされていません。' +
        '多言語デモを実行するには `npm i i18next i18next-fs-backend` が必要です。',
      );
      return false;
    }
    throw e;
  }
  return new Promise((resolve) => {
    i18next.use(Backend).init({
      lng: config.DEFAULT_LANG,
      fallbackLng: 'en',
      backend: {
        loadPath: path.join(__dirname, 'locales/{{lng}}/translation.json')
      }
    }, (err) => {
      if (err) {
        console.error(`i18next の初期化に失敗しました: ${err.message || err}`);
        return resolve(false);
      }
      // 多言語メッセージ例
      console.log(i18next.t('welcome'));
      // エラー発生時例
      // console.error(i18next.t('error'));
      resolve(true);
    });
  });
}

if (require.main === module) {
  runI18nSample().then((ok) => {
    if (!ok) process.exitCode = 1;
  }).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

module.exports = { runI18nSample };
