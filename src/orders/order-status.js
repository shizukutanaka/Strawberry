// src/orders/order-status.js — 注文が「終わっている」かの単一の定義。
//
// この判定はこれまで 2 箇所に別々の名前で複製されていた
// （order/index.js の TERMINAL_SESSION_STATUSES、payout-ledger.js の
// CREDITABLE_ORDER_STATUSES）。値が同じなのは偶然ではない: この製品では異常終了を
// すべて 'cancelled' に集約し、区別は cancelReason が持つ。だから「セッションを
// 回収してよいか」「金を計上してよいか」「接続情報を捨ててよいか」は、
// すべて同じ一つの問い —— **この注文はもう終わっているか** —— に帰着する。
//
// 3 つ目の複製が生まれる前にここへ集約した。新しい終端状態を足すなら、ここだけを
// 直せば 3 つの用途すべてに伝わる。
const TERMINAL_ORDER_STATUSES = Object.freeze(new Set(['completed', 'cancelled']));

function isTerminalOrderStatus(status) {
  return TERMINAL_ORDER_STATUSES.has(status);
}

module.exports = { TERMINAL_ORDER_STATUSES, isTerminalOrderStatus };
