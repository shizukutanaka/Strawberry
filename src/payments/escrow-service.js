// src/payments/escrow-service.js
// エスクロー・サービス（docs/SPECIFICATION.md F2）。状態機械(escrow-state-machine)と
// 永続化(EscrowRepository)を束ね、注文ごとのエスクローを生成・遷移・記録する。
// 検証結果(work-verifier)による解放判断もここで適用する。
// repository は DI 可能（既定は JSON リポジトリ、テストはインメモリ fake を注入）。
const { initial, transition, applyDecision } = require('./escrow-state-machine');
const { computeSettlement } = require('./settlement-calculator');

function createEscrowService({ repository } = {}) {
  // 遅延 require: テスト時は repository を注入し、JSON 層を読み込まない
  const repo = repository || require('../db/json/EscrowRepository');

  function persist(escrow, result, event) {
    const now = new Date().toISOString();
    return repo.update(escrow.id, {
      state: result.state,
      updatedAt: now,
      history: [
        ...(escrow.history || []),
        { event, actions: result.actions, state: result.state, at: now },
      ],
    });
  }

  function getOrThrow(escrowId) {
    const escrow = repo.getById(escrowId);
    if (!escrow) throw new Error(`escrow not found: ${escrowId}`);
    return escrow;
  }

  // 単一イベントを適用して永続化（無効遷移は state machine が throw）
  function apply(escrowId, event) {
    const escrow = getOrThrow(escrowId);
    const result = transition(escrow.state, event);
    return { escrow: persist(escrow, result, event), actions: result.actions, event };
  }

  return {
    /** 注文に対するエスクローを生成（PENDING）。hold invoice 情報は invoice に格納。 */
    create({ orderId, amountSats, feeRate = 0, deadlineAt = null, invoice = null }) {
      if (!orderId) throw new Error('orderId required');
      if (typeof amountSats !== 'number' || !Number.isFinite(amountSats) || amountSats <= 0) {
        throw new Error('amountSats must be a positive finite number');
      }
      const clampedFeeRate = typeof feeRate === 'number' && Number.isFinite(feeRate)
        ? Math.max(0, Math.min(0.99, feeRate))
        : 0;
      return repo.create({
        orderId,
        amountSats,
        feeRate: clampedFeeRate,
        deadlineAt,
        invoice,
        state: initial(),
        history: [],
      });
    },

    /** hold invoice が入金された（PENDING→HELD, preimage 秘匿）。 */
    markPaid: (escrowId) => apply(escrowId, 'PAY'),

    /** 借り手都合のキャンセル。 */
    cancel: (escrowId) => apply(escrowId, 'CANCEL'),

    /** 期限到来。 */
    expire: (escrowId) => apply(escrowId, 'DEADLINE'),

    /** 係争の解決（'settle' で確定 / 'refund' で返金＋slash）。 */
    resolveDispute: (escrowId, decision) => {
      const event =
        decision === 'settle' ? 'RESOLVE_SETTLE' : decision === 'refund' ? 'RESOLVE_REFUND' : null;
      if (!event) throw new Error(`invalid dispute decision: ${decision}`);
      return apply(escrowId, event);
    },

    /**
     * 検証結果(work-verifier の verified/suspectedZeroLoad)＋期限から解放判断を適用。
     * WAIT のときは状態を変えず履歴も増やさない。
     */
    evaluate(escrowId, verificationCtx = {}) {
      const escrow = getOrThrow(escrowId);
      const decision = applyDecision(escrow.state, verificationCtx);
      if (decision.event === 'WAIT') {
        return { escrow, actions: [], event: 'WAIT' };
      }
      const saved = persist(escrow, { state: decision.state, actions: decision.actions }, decision.event);
      return { escrow: saved, actions: decision.actions, event: decision.event };
    },

    /**
     * 実使用量・SLA に応じた精算内訳を計算して永続化する（従量按分）。
     * 状態は変えず、settlement フィールドと history に記録する。SETTLED への遷移後、
     * action-executor が payout_provider/refund_renter を実行する際の金額根拠になる。
     * @param {string} escrowId
     * @param {object} usage { deliveredRatio, slaUptimePct }
     * @param {object} opts settlement-calculator のポリシー上書き
     * @returns {{escrow, settlement}}
     */
    settle(escrowId, usage = {}, opts = {}) {
      const escrow = getOrThrow(escrowId);
      const settlement = computeSettlement(
        {
          totalSats: escrow.amountSats,
          deliveredRatio: usage.deliveredRatio,
          slaUptimePct: usage.slaUptimePct,
          feeRate: escrow.feeRate || 0,
        },
        opts,
      );
      const now = new Date().toISOString();
      const saved = repo.update(escrow.id, {
        settlement,
        updatedAt: now,
        history: [
          ...(escrow.history || []),
          { event: 'SETTLEMENT_COMPUTED', settlement, state: escrow.state, at: now },
        ],
      });
      return { escrow: saved, settlement };
    },

    apply,
    get: (escrowId) => repo.getById(escrowId),
  };
}

module.exports = { createEscrowService };
