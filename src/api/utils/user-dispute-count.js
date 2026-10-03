// src/api/utils/user-dispute-count.js
// 係争裁定カウンタ（vindicatedDisputeCount / deniedDisputeCount）の +1 加算。
// 裁定は order 単位の withLock 内で行われるが、同一申請者（raiser）の別注文が
// 並行に裁定されると getById→update の読み書き間に競合し、カウンタが消失更新
// （lost-update）される。ユーザー単位のロックで直列化して加算を保証する。
const { withLock } = require('../../utils/async-lock');
const UserRepository = require('../../db/json/UserRepository');

/**
 * 指定フィールドの係争カウンタを原子的に +1 する。
 * @param {string} userId - 対象ユーザーID（dispute.raisedBy）
 * @param {'vindicatedDisputeCount'|'deniedDisputeCount'} field
 * @returns {Promise<number|null>} 加算後の値。ユーザー不在時は null（例外は投げない）
 */
async function incrementDisputeCount(userId, field) {
  return withLock(`user:${userId}:disputeCount`, async () => {
    const u = UserRepository.getById(userId);
    if (!u) return null;
    const next = (u[field] || 0) + 1;
    UserRepository.update(userId, { [field]: next });
    return next;
  });
}

module.exports = { incrementDisputeCount };
