// src/payments/settlement-calculator.js
// 従量・SLA 連動の決済精算計算（docs/SPECIFICATION.md F1.4 / F3）。
// エスクローの確定額は現状「全額 payout か全額 refund」の二択だが、Akash/Golem や
// 一般的なクラウド従量課金は「実際に提供された使用量（heartbeat で計測される
// accumulatedSeconds）」に応じて按分精算する。本モジュールはエスクロー総額を
// プロバイダ payout / 借り手 refund / 運営 fee に分割する純関数。
// FSM(escrow-state-machine) が「状態」を、本計算が「金額」を決める分担。
//
// 整数 sats で計算し、payout + fee + refund === total を厳密に保証する（端数は fee に寄せる）。

function num(v, def = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

const DEFAULTS = {
  minChargeRatio: 0.1,   // 最低課金（セットアップ費）: 即時解約でも総額の 10% は課金
  slaThresholdPct: 95,   // この稼働率を下回ると SLA ペナルティを適用
  slaPenaltyMax: 0.5,    // 稼働率 0% 相当で課金の最大 50% を借り手へ返戻
};

/**
 * 実使用量・SLA からエスクロー総額の精算内訳を計算する。
 * @param {object} input
 *   totalSats        … エスクロー総額（hold invoice 額面）
 *   deliveredRatio   … 実提供割合 [0,1]（= accumulatedSeconds / 予約秒数）
 *   slaUptimePct     … 当該ジョブ中の稼働率(%) 既定100
 *   feeRate          … 運営手数料率 [0,1)（課金額に対して）
 * @param {object} opts minChargeRatio / slaThresholdPct / slaPenaltyMax の上書き
 * @returns {{providerPayoutSats:number, renterRefundSats:number, operatorFeeSats:number,
 *           chargedSats:number, breakdown:object}}
 */
function computeSettlement(input = {}, opts = {}) {
  const total = Math.max(0, Math.round(num(input.totalSats)));
  const deliveredRatio = clamp01(num(input.deliveredRatio, 0));
  const slaUptimePct = clamp01(num(input.slaUptimePct, 100) / 100) * 100;
  const feeRate = Math.max(0, Math.min(0.99, num(input.feeRate, 0)));

  const {
    minChargeRatio = DEFAULTS.minChargeRatio,
    slaThresholdPct = DEFAULTS.slaThresholdPct,
    slaPenaltyMax = DEFAULTS.slaPenaltyMax,
  } = opts;

  if (total === 0) {
    return {
      providerPayoutSats: 0, renterRefundSats: 0, operatorFeeSats: 0, chargedSats: 0,
      breakdown: { total: 0, deliveredRatio, effectiveRatio: 0, slaPenalty: 0, feeRate },
    };
  }

  // 1. 実使用量による按分（ただし最低課金を下限とする）
  const usageRatio = Math.max(deliveredRatio, clamp01(minChargeRatio));

  // 2. SLA ペナルティ: 閾値未満の稼働率に比例して課金を減らし借り手へ返戻
  let slaPenalty = 0;
  if (slaUptimePct < slaThresholdPct && slaThresholdPct > 0) {
    const shortfall = (slaThresholdPct - slaUptimePct) / slaThresholdPct; // 0..1
    slaPenalty = clamp01(shortfall) * clamp01(slaPenaltyMax);
  }

  const effectiveRatio = clamp01(usageRatio * (1 - slaPenalty));

  // 3. 課金額（プロバイダ＋運営の取り分）。残りは借り手へ返金。
  const chargedSats = Math.min(total, Math.round(total * effectiveRatio));
  const renterRefundSats = total - chargedSats;

  // 4. 課金額から運営手数料を控除し、残りがプロバイダ payout。
  //    旧実装は payout を Math.round し fee を残差にしていたため、charged * feeRate < 0.5
  //    のとき operatorFeeSats が常に 0 となり手数料回避(reverse fee evasion)を許していた。
  //    fee 側を ceil し、feeRate>0 のときは最低 1 sat 徴収する。feeRate==0 のときは 0 のまま。
  let operatorFeeSats;
  if (chargedSats <= 0 || feeRate <= 0) {
    operatorFeeSats = 0;
  } else {
    operatorFeeSats = Math.min(chargedSats, Math.max(1, Math.ceil(chargedSats * feeRate)));
  }
  const providerPayoutSats = chargedSats - operatorFeeSats;

  return {
    providerPayoutSats,
    renterRefundSats,
    operatorFeeSats,
    chargedSats,
    breakdown: {
      total, deliveredRatio, usageRatio, slaUptimePct, slaPenalty, effectiveRatio, feeRate,
    },
  };
}

module.exports = { computeSettlement, DEFAULTS };
