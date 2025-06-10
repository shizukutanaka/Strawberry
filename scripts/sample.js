const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const path = require('path');
const config = require('./config');

i18next.use(Backend).init({
  lng: config.DEFAULT_LANG,
  fallbackLng: 'en',
  backend: {
    loadPath: path.join(__dirname, 'locales/{{lng}}/translation.json')
  }
}, () => {
  // 多言語メッセージ例
  console.log(i18next.t('welcome'));
  // エラー発生時例
  // console.error(i18next.t('error'));
});
