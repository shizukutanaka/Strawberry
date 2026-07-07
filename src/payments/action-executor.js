// src/payments/action-executor.js
// エスクロー actions の実行層（docs/SPECIFICATION.md §6: LN 結線）。
// escrow-state-machine が返す actions（reveal_preimage 等）を ln-adapter 経由の
// 実 LN 操作へマッピングする。LN に対応しないドメイン操作（slash 等）は no-op として記録。
// adapter は DI（テストは MockLnAdapter）。

// LN 操作にマップされる action -> 実行関数(adapter, ctx)
const LN_ACTIONS = {
  reveal_preimage: (adapter, ctx) => adapter.settleHoldInvoice(ctx.preimage),
  cancel_invoice: (adapter, ctx) => adapter.cancelHoldInvoice(ctx.preimageHash),
  payout_provider: (adapter, ctx) => adapter.payInvoice(ctx.providerInvoice, ctx.payoutSats),
};

// LN 操作を伴わないドメイン専用 action（他レイヤで処理 or 暗黙に達成）
//  - hold_preimage : invoice 生成時点で hold 済み
//  - refund_renter : cancel_invoice による HTLC 失効で自動返金
//  - collect_fee   : 運営が手数料を留保（payout 純額計算側）
//  - open_dispute / slash_provider : 係争/レピュテーション側で処理
const DOMAIN_ACTIONS = new Set([
  'hold_preimage', 'refund_renter', 'collect_fee', 'open_dispute', 'slash_provider',
]);

/**
 * actions を順に実行する。
 * @param {string[]} actions escrow から返された action 列
 * @param {object} ctx { preimage, preimageHash, providerInvoice, payoutSats }
 * @param {object} adapter ln-adapter 実装（settleHoldInvoice/cancelHoldInvoice/payInvoice）
 * @returns {Promise<Array<{action:string, kind:'ln'|'domain'|'unknown', result:*}>>}
 */
async function executeActions(actions, ctx = {}, adapter) {
  if (!Array.isArray(actions)) throw new Error('actions must be an array');
  if (!adapter) throw new Error('adapter is required');

  const results = [];
  for (const action of actions) {
    if (LN_ACTIONS[action]) {
      const result = await LN_ACTIONS[action](adapter, ctx);
      results.push({ action, kind: 'ln', result });
    } else if (DOMAIN_ACTIONS.has(action)) {
      results.push({ action, kind: 'domain', result: 'noop' });
    } else {
      results.push({ action, kind: 'unknown', result: 'skipped' });
    }
  }
  return results;
}

module.exports = { executeActions, LN_ACTIONS, DOMAIN_ACTIONS };
