// src/services/renter-eligibility.js
// 借り手が特定の GPU を注文できる資格を判定する単一の真実源（single source of truth）。
//
// この判定は 2 箇所で必要:
//   1. POST /orders（注文作成）— 不適格なら 422 で拒否する強制ゲート
//   2. GET /gpus/:id/eligibility（事前チェック）— 借り手に事前に結果を伝える UX
// 両者が別実装だとルールがドリフトし、事前チェックが「OK」と言ったのに
// 注文作成で 422 になる（あるいは逆）矛盾が起きる。ここに集約して防ぐ。

/**
 * 借り手の現在の平均評価とレビュー件数を算出する。
 * @param {object[]} allOrders 全注文（OrderRepository.getAll() の結果）
 * @param {string} renterId 借り手ユーザー ID
 * @returns {{ average: number|null, count: number, hasHistory: boolean }}
 */
function computeRenterRating(allOrders, renterId) {
  const reviewed = allOrders.filter(o => o.userId === renterId && o.renterReview);
  const count = reviewed.length;
  if (count === 0) return { average: null, count: 0, hasHistory: false };
  const sum = reviewed.reduce(
    (s, o) => s + Math.min(5, Math.max(1, Number(o.renterReview.rating) || 1)),
    0
  );
  const average = Math.round((sum / count) * 10) / 10;
  return { average, count, hasHistory: true };
}

/**
 * 借り手がこの GPU を注文できる資格があるか判定する。
 *
 * 結果オブジェクトの reason コード:
 *   - 'self_trade'         : 借り手 = GPU 提供者（ウォッシュトレード防止）
 *   - 'no_rating_history'  : rejectUnratedRenters=true かつ借り手が未評価
 *   - 'below_rating_floor' : minRenterRating 未満の既知評価
 *   - 'not_available'      : GPU が available:false
 *   - null                 : 適格
 *
 * 注: ここでは「借り手レーティング資格」のみ判定する。時間帯重複（二重予約）・
 * 手動ブロック・洪水上限などの動的チェックは注文作成時の別ロジックが担う。
 *
 * @param {object} gpu GPU レコード
 * @param {string} renterId 借り手ユーザー ID
 * @param {{ average: number|null, count: number, hasHistory: boolean }} rating
 *   computeRenterRating() の結果
 * @returns {{ eligible: boolean, reason: string|null, message: string }}
 */
function evaluateRenterEligibility(gpu, renterId, rating) {
  if (!gpu) {
    return { eligible: false, reason: 'not_found', message: 'GPU not found' };
  }
  if (gpu.providerId === renterId) {
    return { eligible: false, reason: 'self_trade', message: 'You cannot rent your own GPU' };
  }
  if (gpu.rejectUnratedRenters === true && !rating.hasHistory) {
    return {
      eligible: false,
      reason: 'no_rating_history',
      message: 'This GPU requires renters to have a rating history. Complete at least one rental on another GPU first.',
    };
  }
  if (gpu.minRenterRating && rating.hasHistory && rating.average < gpu.minRenterRating) {
    return {
      eligible: false,
      reason: 'below_rating_floor',
      message: `This GPU requires a renter rating of at least ${gpu.minRenterRating}. Your current rating is ${rating.average}.`,
    };
  }
  if (gpu.available === false) {
    return {
      eligible: false,
      reason: 'not_available',
      message: 'This GPU is currently not available for booking.',
    };
  }
  return { eligible: true, reason: null, message: 'You are eligible to rent this GPU.' };
}

module.exports = { computeRenterRating, evaluateRenterEligibility };
