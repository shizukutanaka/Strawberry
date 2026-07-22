// src/payments/escrow-service.js
// エスクロー・サービス（docs/SPECIFICATION.md F2）。状態機械(escrow-state-machine)と
// 永続化(EscrowRepository)を束ね、注文ごとのエスクローを生成・遷移・記録する。
// 検証結果(work-verifier)による解放判断もここで適用する。
// repository は DI 可能（既定は JSON リポジトリ、テストはインメモリ fake を注入）。
//
// lnAdapter（任意 DI）: 状態機械が返す actions（reveal_preimage/payout_provider/
// cancel_invoice 等）を action-executor 経由で実 LN 操作へ実行する。これまで actions は
// 計算されるだけで呼び出し側が使わず（このファイル自身のコメントが「action-executor が
// 実行する」と述べていたにも関わらず）実際には誰も呼んでいなかった —
// 計算した資金移動の意図を実行しない、というエスクローとして致命的なギャップだった。
// lnAdapter を渡さない既存呼び出し側は一切動作を変えない（後方互換・ゼロリスク）。
const { initial, transition, applyDecision } = require('./escrow-state-machine');
const { computeSettlement } = require('./settlement-calculator');
const { executeActions } = require('./action-executor');

function createEscrowService({ repository, lnAdapter } = {}) {
  // 遅延 require: テスト時は repository を注入し、JSON 層を読み込まない
  const repo = repository || require('../db/json/EscrowRepository');

  // actions を lnAdapter 経由で実行し、結果を履歴へ追記する。lnAdapter 未指定時は
  // 何もしない（呼び出し元が LN 結線をまだ持たない場合の後方互換）。
  // ベストエフォート: LN 実行の失敗で状態遷移そのものは取り消さない
  // （他の best-effort 箇所 — order/index.js の escrow 精算等 — と同じ方針）。
  async function runActions(escrow, actions, extra = {}) {
    if (!lnAdapter || !Array.isArray(actions) || actions.length === 0) return null;
    const ctx = {
      preimage: escrow.preimage,
      preimageHash: escrow.preimageHash,
      providerInvoice: escrow.providerInvoice,
      payoutSats: (escrow.settlement && escrow.settlement.providerPayoutSats) ?? escrow.amountSats,
      ...extra,
    };
    try {
      const results = await executeActions(actions, ctx, lnAdapter);
      const now = new Date().toISOString();
      repo.update(escrow.id, {
        updatedAt: now,
        history: [
          ...(escrow.history || []),
          { event: 'LN_ACTIONS_EXECUTED', results, at: now },
        ],
      });
      return results;
    } catch (e) {
      const now = new Date().toISOString();
      repo.update(escrow.id, {
        updatedAt: now,
        history: [
          ...(escrow.history || []),
          { event: 'LN_ACTIONS_FAILED', error: e.message, actions, at: now },
        ],
      });
      return null;
    }
  }

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

  // 単一イベントを適用して永続化（無効遷移は state machine が throw）。
  // 同期関数のまま維持する（全既存呼び出し側が同期戻り値 {escrow,actions,event} を
  // 前提にしているため、async 化は呼び出し側全体を破壊する）。LN 実行は
  // fire-and-forget のベストエフォート（vgpuManager.releaseGPU と同じ既存パターン）。
  function apply(escrowId, event) {
    const escrow = getOrThrow(escrowId);
    const result = transition(escrow.state, event);
    const saved = persist(escrow, result, event);
    runActions(saved, result.actions).catch(() => {});
    return { escrow: saved, actions: result.actions, event };
  }

  return {
    /**
     * 注文に対するエスクローを生成（PENDING）。hold invoice 情報は invoice に格納。
     * preimage/preimageHash/providerInvoice は LN 決済（runActions）に必須の文脈:
     *   - reveal_preimage → settleHoldInvoice(preimage)（確定）
     *   - cancel_invoice  → cancelHoldInvoice(preimageHash)（取消/返金）
     *   - payout_provider → payInvoice(providerInvoice, payoutSats)（貸し手へ送金）
     * これらは runActions が escrow.<field> として読むが、以前は create が保存して
     * いなかったため常に undefined になり、payout 先が失われて送金が成立しなかった。
     * 後方互換: 未指定なら従来通り undefined（LN 結線を持たない BTC オンチェーン
     * エスクロー等は影響なし）。
     */
    create({ orderId, amountSats, feeRate = 0, deadlineAt = null, invoice = null, preimage = null, preimageHash = null, providerInvoice = null }) {
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
        preimage,
        preimageHash,
        providerInvoice,
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
      runActions(saved, decision.actions).catch(() => {});
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
