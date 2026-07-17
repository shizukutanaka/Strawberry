// src/payments/escrow-state-machine.js
// Lightning hold-invoice エスクロー状態機械（docs/SPECIFICATION.md F2 / カテゴリ2）。
// 現状の btc-payment.sendBTC は前払い保証なしの二段直接送金で、未提供/未払いリスクと
// 部分決済(資金滞留)を生む。本 FSM は hold invoice（受取側が preimage を保持し納品証明まで
// 確定保留）のライフサイクルを純粋な状態遷移として表現する。LND/CLN 実機なしでテスト可能。
//
// 返す actions は「副作用の意図」。実配線時に LND gRPC 等へマッピングする:
//   hold_preimage    … preimage を秘匿してエスクロー保持（settle/cancel まで）
//   reveal_preimage  … preimage 公開＝送金確定（プロバイダへ payout、運営 fee 控除）
//   cancel_invoice   … hold invoice を取消（HTLC タイムロック失効で借り手へ返金）
//   refund_renter / payout_provider / collect_fee / open_dispute / slash_provider

const STATES = Object.freeze({
  PENDING: 'PENDING',   // 生成済、hold invoice 入金待ち
  HELD: 'HELD',         // 入金済、preimage 秘匿中（エスクロー保持）
  SETTLED: 'SETTLED',   // 確定（terminal）
  CANCELED: 'CANCELED', // 取消/返金（terminal）
  DISPUTED: 'DISPUTED', // 係争（検証失敗/期限到来）
});

const TERMINAL = new Set([STATES.SETTLED, STATES.CANCELED]);

// 遷移表: state -> event -> { to, actions }
const TRANSITIONS = {
  [STATES.PENDING]: {
    PAY: { to: STATES.HELD, actions: ['hold_preimage'] },
    CANCEL: { to: STATES.CANCELED, actions: ['cancel_invoice'] },
    DEADLINE: { to: STATES.CANCELED, actions: ['cancel_invoice'] },
  },
  [STATES.HELD]: {
    DELIVER_OK: { to: STATES.SETTLED, actions: ['reveal_preimage', 'payout_provider', 'collect_fee'] },
    DELIVER_FAIL: { to: STATES.DISPUTED, actions: ['hold_preimage', 'open_dispute'] },
    CANCEL: { to: STATES.CANCELED, actions: ['cancel_invoice', 'refund_renter'] },
    DEADLINE: { to: STATES.DISPUTED, actions: ['open_dispute'] },
  },
  [STATES.DISPUTED]: {
    RESOLVE_SETTLE: { to: STATES.SETTLED, actions: ['reveal_preimage', 'payout_provider', 'collect_fee'] },
    RESOLVE_REFUND: { to: STATES.CANCELED, actions: ['cancel_invoice', 'refund_renter', 'slash_provider'] },
    // 管理者・自動裁定が一定期間到来しなかった場合の安全出口。これが無いと DISPUTED は
    // FSM レベルで永久にロックされ、order-expiry 側が escrow を生 update する迂回
    // （状態desync の温床）を強いられていた。既定は借り手保護で返金側へ倒す。
    DEADLINE: { to: STATES.CANCELED, actions: ['cancel_invoice', 'refund_renter', 'slash_provider'] },
  },
};

function isTerminal(state) {
  return TERMINAL.has(state);
}

/**
 * 非 throw 版の遷移計算。許可されない遷移・未知状態では例外を投げず
 * { ok: false, reason } を返す。try/catch で包まれていない呼び出し側が
 * 想定外イベント 1 つで決済フロー全体をクラッシュさせないためのガード版。
 * @returns {{ok:true, state:string, actions:string[]} | {ok:false, reason:string}}
 */
function tryTransition(state, event) {
  if (!TRANSITIONS[state]) {
    return { ok: false, reason: isTerminal(state) ? 'terminal_state' : 'unknown_state' };
  }
  const t = TRANSITIONS[state][event];
  if (!t) return { ok: false, reason: 'invalid_transition' };
  return { ok: true, state: t.to, actions: [...t.actions] };
}

function initial() {
  return STATES.PENDING;
}

/**
 * 状態遷移を計算する純関数。
 * @param {string} state 現在状態
 * @param {string} event イベント名
 * @returns {{state:string, actions:string[]}}
 * @throws 未知の状態/イベント、または許可されない遷移
 */
function transition(state, event) {
  if (!TRANSITIONS[state] && !isTerminal(state)) {
    throw new Error(`unknown escrow state: ${state}`);
  }
  const table = TRANSITIONS[state];
  const t = table && table[event];
  if (!t) {
    throw new Error(`invalid transition: ${event} from ${state}`);
  }
  return { state: t.to, actions: [...t.actions] };
}

/**
 * HELD のエスクローに対し、検証結果・期限から推奨イベントを返す。
 * `src/verification/work-verifier.js` の出力（verified, suspectedZeroLoad）と連携する想定。
 * @param {object} ctx { verified:boolean|null, suspectedZeroLoad:boolean,
 *                        deadlinePassed:boolean, deliveredRatio:number(0..1), minDeliveredRatio:number }
 * @returns {'DELIVER_OK'|'DELIVER_FAIL'|'WAIT'}
 */
function decideSettlement(ctx = {}) {
  const {
    verified = null,
    suspectedZeroLoad = false,
    deadlinePassed = false,
    deliveredRatio = 0,
    minDeliveredRatio = 0.9,
  } = ctx;

  if (verified === false || suspectedZeroLoad === true) return 'DELIVER_FAIL';
  if (verified === true) return 'DELIVER_OK';
  if (deadlinePassed) {
    return deliveredRatio >= minDeliveredRatio ? 'DELIVER_OK' : 'DELIVER_FAIL';
  }
  return 'WAIT';
}

/**
 * decideSettlement の結果を状態へ適用する便利関数。WAIT のときは状態を変えない。
 * @returns {{state:string, actions:string[], event:string}}
 */
function applyDecision(state, ctx = {}) {
  const event = decideSettlement(ctx);
  if (event === 'WAIT') return { state, actions: [], event };
  const next = transition(state, event);
  return { ...next, event };
}

module.exports = { STATES, isTerminal, initial, transition, tryTransition, decideSettlement, applyDecision };
