// src/utils/request-context.js
// リクエストスコープのコンテキストを AsyncLocalStorage で伝播する。
// 目的: 1 リクエスト処理中に発生するすべての logger.* 呼び出しへ、明示的に引数を
// 引き回すことなく requestId を付与できるようにする（I-11 のエラーログ相関を全ログへ拡張）。
//
// AsyncLocalStorage は同期・await・Promise チェーンをまたいでコンテキストを維持する。
// store は Map ではなく単純なプレーンオブジェクトとし、{ requestId } を保持する。
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/**
 * 指定コンテキスト下で fn を実行する。fn 内（および await 連鎖の先）からは
 * getRequestId() で requestId を取得できる。
 * @param {{ requestId?: string }} context
 * @param {Function} fn
 */
function runWithContext(context, fn) {
  return als.run(context || {}, fn);
}

/** 現在のリクエストの requestId を返す（コンテキスト外なら undefined）。 */
function getRequestId() {
  const store = als.getStore();
  return store ? store.requestId : undefined;
}

module.exports = { als, runWithContext, getRequestId };
