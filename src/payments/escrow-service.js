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
    // 楽観的 CAS: 永続化時点でも state が変わっていないことを確認する。
    // updateIf が null を返したら並行遷移が先に確定している — 呼び出し側に伝播させる。
    const writeResult = repo.updateIf
      ? repo.updateIf(escrow.id, (e) => e.state === escrow.state, {
          state: result.state,
          updatedAt: now,
          history: [
            ...(escrow.history || []),
            { event, actions: result.actions, state: result.state, at: now },
          ],
        })
      : repo.update(escrow.id, {
          state: result.state,
          updatedAt: now,
          history: [
            ...(escrow.history || []),
            { event, actions: result.actions, state: result.state, at: now },
          ],
        });
    // updateIf は {ok, row} を返す（null/undefined では返らない）。ok===false は CAS 失敗。
    // repo.update（updateIf 非対応フォールバック）は更新行を直接返す。
    const saved = writeResult && typeof writeResult.ok !== 'undefined' ? writeResult.row : writeResult;
    if (!saved || (writeResult && writeResult.ok === false)) {
      throw new Error(`escrow ${escrow.id} state changed concurrently; transition '${event}' was not applied`);
    }
    return saved;
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
      // 同一注文への二重エスクロー開設を防ぐ: CANCELED 以外のエスクローが既に存在する場合は拒否。
      // 重複 open は二重課金・二重払い出しの原因になる。
      if (repo.getByOrderId) {
        const existing = repo.getByOrderId(orderId) || [];
        const active = existing.filter((e) => e.state !== 'CANCELED');
        if (active.length > 0) {
          throw new Error(`escrow already exists for order ${orderId} (id=${active[0].id}, state=${active[0].state})`);
        }
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
      // updateIf guards against overwriting a settlement that a concurrent path
      // (e.g., /verify racing /resolve after the lock key unification) already wrote.
      // The predicate re-checks the current state to ensure we still own the write.
      const writeResult = repo.updateIf
        ? repo.updateIf(escrow.id, (e) => !['SETTLED', 'CANCELED'].includes(e.state) && !e.settlement, {
            settlement,
            updatedAt: now,
            history: [
              ...(escrow.history || []),
              { event: 'SETTLEMENT_COMPUTED', settlement, state: escrow.state, at: now },
            ],
          })
        : { ok: true, row: repo.update(escrow.id, { settlement, updatedAt: now,
            history: [...(escrow.history || []), { event: 'SETTLEMENT_COMPUTED', settlement, state: escrow.state, at: now }] }) };
      if (!writeResult.ok) {
        throw Object.assign(new Error('Settlement already written by a concurrent operation'), { code: 'CONCURRENT_SETTLE' });
      }
      return { escrow: writeResult.row, settlement };
    },

    apply,
    get: (escrowId) => repo.getById(escrowId),
  };
}

module.exports = { createEscrowService };
