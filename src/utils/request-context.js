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

/** 現在のリクエストの traceId（W3C Trace Context）を返す（無ければ undefined）。 */
function getTraceId() {
  const store = als.getStore();
  return store ? store.traceId : undefined;
}

// W3C Trace Context の traceparent ヘッダから trace-id を厳格に取り出す。
// 形式: {version:2hex}-{trace-id:32hex}-{parent-id:16hex}-{flags:2hex}
//   例: 00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01
// 上流（API Gateway / 他サービス）が付与した trace-id を再利用してログを横断相関する。
// 不正値・version ff・全ゼロの trace-id/parent-id は仕様上無効として null を返す
// （信頼できない trace-id でログを汚染しない）。
const _TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
function parseTraceId(traceparent) {
  if (typeof traceparent !== 'string') return null;
  const m = _TRACEPARENT_RE.exec(traceparent);
  if (!m) return null;
  const [, version, traceId, parentId] = m;
  if (version === 'ff') return null;       // 予約済み・無効バージョン
  if (/^0+$/.test(traceId)) return null;   // 全ゼロ trace-id は無効
  if (/^0+$/.test(parentId)) return null;  // 全ゼロ parent-id は無効
  return traceId;
}

module.exports = { als, runWithContext, getRequestId, getTraceId, parseTraceId };
