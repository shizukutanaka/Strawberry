// src/services/price-watch.js
// GPU の値下げ検知 + 空き状態復帰検知 + ウォッチ作成時の即時通知ロジック。
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
      // 価格変動パス: 同額/より高い価格で通知済みなら抑制。
      // ただし価格が一度 lastNotifiedPrice を上回った後に再度同じ価格に下がった場合は
      // 「価格が上がって戻った」独立イベントとして通知する。
      // 抑制条件: (1) lNP <= newPrice かつ (2) previousPrice <= lNP（価格がlNPを超えなかった）
      // 注: isPriceDrop(newPrice < previousPrice) と合わせると
      //   previousPrice <= lNP <= newPrice < previousPrice → previousPrice < previousPrice（矛盾）
      // となるため事実上 lNP > newPrice（新安値）以外では suppress されない。
      // 換言: previousPrice > lNP のとき (「一度上昇」あり) は必ず通知する。
      if (typeof w.lastNotifiedPrice === 'number') {
        const alreadyAtOrBelow = w.lastNotifiedPrice <= newPrice;
        const noRiseSinceNotify = typeof previousPrice !== 'number' || previousPrice <= w.lastNotifiedPrice;
        if (alreadyAtOrBelow && noRiseSinceNotify) continue;
      }
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

/**
 * ウォッチ登録直後に呼び出す即時通知。
 * 現在の GPU 価格がすでに targetPrice 以下かつ GPU がレンタル可能な場合に通知する。
 *
 * 理由: notifyPriceWatchers は「価格が変化した瞬間」にのみ発火するため、
 * ウォッチ登録時点で GPU が既に目標価格以下だった場合（$2.50 目標に対して現在 $2.00 等）、
 * 以後価格が変化しなければ通知が一切届かず、ウォッチが「永久に沈黙」してしまう。
 * これはウォッチャーが「通知が来るはずだ」と期待して待ち続ける UX バグである。
 *
 * @param {object} gpu   現在の GPU レコード
 * @param {object} watch 登録/更新されたウォッチ { id, userId, targetPrice, ... }
 * @param {{repo?:object, notify?:Function}} [deps]
 * @returns {boolean} 通知したかどうか
 */
function notifyWatchJustCreated(gpu, watch, deps = {}) {
  const repo = deps.repo || WatchRepository;
  const notify = deps.notify || notifyUser;
  if (!gpu || typeof gpu.pricePerHour !== 'number') return false;
  if (!watch || typeof watch.targetPrice !== 'number') return false;
  // GPU がレンタル可能かつ現在価格が目標以下でなければ即時通知は不要
  if (gpu.available === false) return false;
  if (gpu.pricePerHour > watch.targetPrice) return false;
  // 自分の出品への通知は不要（POST /watch で 403 を返すが二重チェック）
  if (watch.userId === gpu.providerId) return false;

  const price = gpu.pricePerHour;
  const msg = `【Strawberry】ウォッチを設定しました。GPU「${gpu.name || gpu.id}」はすでに目標価格以下です: ` +
    `${price}（あなたの目標 ${watch.targetPrice} 以下）。今すぐレンタルできます。`;
  const subject = `ウォッチ設定完了: GPU「${gpu.name || gpu.id}」はすでに目標価格以下です`;
  try {
    notify(watch.userId, 'gpu_watch_price_already_met', msg, { subject });
  } catch (e) {
    logger.warn(`price-watch: immediate notify failed (user=${watch.userId}): ${e.message}`);
    return false;
  }
  try {
    repo.update(watch.id, { lastNotifiedPrice: price, lastNotifiedAt: new Date().toISOString() });
  } catch (e) {
    logger.warn(`price-watch: failed to mark watch ${watch.id} notified: ${e.message}`);
  }
  return true;
}

module.exports = { notifyPriceWatchers, notifyWatchJustCreated };
