// src/services/price-watch.js
// GPU の値下げ検知 → ウォッチャーへの通知ロジック。GPU 更新ルートから呼ばれる。
// テスト容易性のため repo / notify を注入可能にする（既定は実リポジトリと user-notify）。
const WatchRepository = require('../db/json/WatchRepository');
const { notifyUser } = require('../utils/user-notify');
const { logger } = require('../utils/logger');

/**
 * GPU が値下げされた際、目標価格に到達したウォッチャーへ通知する（fire-and-forget）。
 * 再通知の抑制: 同じ/より高い価格では再通知しない（さらに値下げが進んだ時のみ再通知）。
 * 自分が出品者のウォッチは通知しない。
 * @param {object} gpu 更新後の GPU（pricePerHour は更新後の価格）
 * @param {number} previousPrice 更新前の pricePerHour
 * @param {{repo?:object, notify?:Function}} [deps]
 * @returns {number} 通知したウォッチャー数
 */
function notifyPriceWatchers(gpu, previousPrice, deps = {}) {
  const repo = deps.repo || WatchRepository;
  const notify = deps.notify || notifyUser;
  if (!gpu || typeof gpu.pricePerHour !== 'number' || typeof gpu.id !== 'string') return 0;
  const newPrice = gpu.pricePerHour;
  // 値下げ時のみ作動（同額・値上げ・不正値は無視）
  if (!(typeof previousPrice === 'number' && newPrice < previousPrice)) return 0;
  // レンタル不可（available===false）の GPU は通知しない。マーケットプレイスは
  // この GPU を一覧・詳細から除外しており（available!==false でフィルタ）、借りられない
  // GPU の値下げ通知は「行動できない偽シグナル」でありアラートの信頼性を損なう。
  if (gpu.available === false) return 0;

  let watches;
  try {
    watches = repo.getByGpu(gpu.id) || [];
  } catch (e) {
    logger.warn(`price-watch: failed to load watches for gpu=${gpu.id}: ${e.message}`);
    return 0;
  }

  let notified = 0;
  for (const w of watches) {
    if (!w || typeof w.targetPrice !== 'number') continue;
    if (w.userId === gpu.providerId) continue;         // 自分の出品は通知しない
    if (newPrice > w.targetPrice) continue;            // まだ目標価格に届いていない
    // 同額/より高い価格で既に通知済みなら抑制（さらに値下げした時のみ再通知）
    if (typeof w.lastNotifiedPrice === 'number' && w.lastNotifiedPrice <= newPrice) continue;

    const msg = `【Strawberry】ウォッチ中のGPU「${gpu.name || gpu.id}」が値下げされました: ` +
      `${newPrice}（あなたの目標 ${w.targetPrice} 以下）`;
    try {
      notify(w.userId, 'gpu_price_drop', msg, { subject: `値下げアラート: ${gpu.name || gpu.id}` });
    } catch (e) {
      logger.warn(`price-watch: notify failed (user=${w.userId}): ${e.message}`);
    }
    try {
      repo.update(w.id, { lastNotifiedPrice: newPrice, lastNotifiedAt: new Date().toISOString() });
    } catch (e) {
      logger.warn(`price-watch: failed to mark watch ${w.id} notified: ${e.message}`);
    }
    notified++;
  }
  return notified;
}

module.exports = { notifyPriceWatchers };
