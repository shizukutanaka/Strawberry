// scripts/lib/optional-dep.js
// optionalDependencies の遅延 require 共有ヘルパー。
// scripts/*.js が optional dep（googleapis / @notionhq/client / @slack/web-api 等）を
// トップレベル require すると、npm が engines/プラットフォーム不一致で
// optionalDependencies をスキップした環境（CI の Node バージョン等）では
// MODULE_NOT_FOUND のスタックだけが出て対処手順が分からない。
// 呼び出し時に解決し、未導入なら導入手順の分かるエラーを投げる。
function requireOptional(name) {
  try {
    return require(name); // eslint-disable-line global-require
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `${name} が未導入です。npm install で optionalDependencies を導入してください（npm i ${name}）`
      );
    }
    throw e;
  }
}

module.exports = { requireOptional };
