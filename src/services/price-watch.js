// src/services/price-watch.js
// GPU の値下げ検知 + 空き状態復帰検知 → ウォッチャーへの通知ロジック。
// テスト容易性のため repo / notify を注入可能にする（既定は実リポジトリと user-notify）。
const WatchRepository = require('../db/json/WatchRepository');
const { notifyUser } = require('../utils/user-notify');
const { logger } = require('../utils/logger');

/**
 * GPU の値下げ、または available:false → available 復帰時に、目標価格に到達した
 * ウォッチャーへ通知する（fire-and-forget）。
 *
 * 通知条件（どちらか一方を満たせばよい）:
 *   1. 値下げ: newPrice < previousPrice
 *   2. 空き復帰: previousAvailable===false かつ gpu.available!==false
 *      （オフライン中に価格が目標以下に達していた場合も捕捉する）
 *
 * 抑制ルール（価格変動イベントのみ適用、空き復帰は別イベントのため除外）:
 *   - 同額/より高い価格で通知済みなら再通知しない
 *
 * @param {object} gpu 更新後の GPU
 * @param {number|{previousPrice:number, previousAvailable?:boolean}} previousInfo
 *   数値の場合は previousPrice のみ（後方互換）。
 *   オブジェクトの場合は { previousPrice, previousAvailable } を受け取る。
 * @param {{repo?:object, notify?:Function}} [deps]
 * @returns {number} 通知したウォッチャー数
 */
function notifyPriceWatchers(gpu, previousInfo, deps = {}) {
  const repo = deps.repo || WatchRepository;
  const notify = deps.notify || notifyUser;
  if (!gpu || typeof gpu.pricePerHour !== 'number' || typeof gpu.id !== 'string') return 0;

  // 後方互換: 第2引数が数値なら previousPrice として扱う
  const previousPrice = typeof previousInfo === 'number'
    ? previousInfo
    : (previousInfo != null ? previousInfo.previousPrice : undefined);
  const previousAvailable = typeof previousInfo === 'number'
    ? undefined
    : (previousInfo != null ? previousInfo.previousAvailable : undefined);

  const newPrice = gpu.pricePerHour;

  // 値下げイベント: newPrice が previousPrice より下がった場合
  const isPriceDrop = typeof previousPrice === 'number' && newPrice < previousPrice;
  // 空き復帰イベント: available:false → 借りられる状態に戻った場合
  // プロバイダがオフライン中に価格を下げてから復帰させたケースを捕捉する。
  // 「actionable な通知」条件に availability を追加した帰結:
  //   available:false 中の値下げは偽シグナルとして抑制 → GPU が戻った瞬間に通知が必要。
  const isAvailabilityRestore = previousAvailable === false && gpu.available !== false;

  if (!isPriceDrop && !isAvailabilityRestore) return 0;

  // 通知対象の GPU がレンタル可能であること（復帰イベントの場合は常に満たされる）
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
    if (w.userId === gpu.providerId) continue;      // 自分の出品は通知しない
    if (newPrice > w.targetPrice) continue;         // 目標価格に届いていない

    if (isPriceDrop && !isAvailabilityRestore) {
      // 価格変動パス: 同額/より高い価格で通知済みなら抑制
      if (typeof w.lastNotifiedPrice === 'number' && w.lastNotifiedPrice <= newPrice) continue;
    }
    // 空き復帰パス: lastNotifiedPrice を抑制に使わない。
    // ウォッチャーは前回の通知時に GPU がオフラインで借りられなかった可能性がある。
    // 「GPU が戻って、かつ目標価格以下」は独立した行動可能なイベントとして扱う。

    const eventLabel = isAvailabilityRestore && !isPriceDrop ? '再出品' : '値下げ';
    const msg = `【Strawberry】ウォッチ中のGPU「${gpu.name || gpu.id}」が${eventLabel}されました: ` +
      `${newPrice}（あなたの目標 ${w.targetPrice} 以下）`;
    const subject = `${eventLabel}アラート: ${gpu.name || gpu.id}`;
    const eventType = isAvailabilityRestore && !isPriceDrop ? 'gpu_available_restored' : 'gpu_price_drop';
    try {
      notify(w.userId, eventType, msg, { subject });
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
