// src/utils/order-pricing.js - 注文価格計算の共通ユーティリティ
// order ルート（一覧/詳細）と payment ルート（注文支払い）で3重に複製されていた
// 「時間単価解決 → 5分単価 → 合計 → JPY換算」ロジックを一本化する。
const { getBTCtoJPYRate } = require('./exchange-rate');
const GpuRepository = require('../db/json/GpuRepository');

// 実効時間単価（sats/h）。注文側に無ければ対象GPUの単価へフォールバックする。
function resolvePricePerHour(order) {
  let pricePerHour = order.pricePerHour || order.maxPricePerHour || 0;
  if (!pricePerHour && order.gpuId) {
    try {
      const gpu = GpuRepository.getById(order.gpuId);
      if (gpu && gpu.pricePerHour) pricePerHour = gpu.pricePerHour;
    } catch (e) { /* GPU未登録時は 0 のまま */ }
  }
  return pricePerHour;
}

// 為替レート情報 {rate, timestamp} を取得（冗長化為替API・キャッシュ活用）
async function fetchRateInfo() {
  return getBTCtoJPYRate(false, true);
}

// 価格内訳を計算する。rateInfo（fetchRateInfo の結果）を渡すと JPY 換算も含む。
// 一覧表示では rateInfo を一度だけ取得して全件に使い回すこと（API呼び出し削減）。
function computeOrderPricing(order, rateInfo = null) {
  const pricePerHour = resolvePricePerHour(order);
  const durationMinutes = order.durationMinutes || 0;
  const pricePer5Min = pricePerHour / 12;

  // 価格ロック: 注文作成時に確定した totalPrice が保存されている場合はそれを権威値とする。
  // 再計算すると、プロバイダが注文後に GPU 価格を変更したとき Lightning 請求額が
  // 合意額より増減する（プロバイダ不正値上げ or 値下げによる損失）。
  // レガシー注文（totalPrice 未保存）のみ以下の再計算にフォールバックする。
  let totalPrice;
  if (order.totalPrice > 0) {
    totalPrice = order.totalPrice;
  } else {
    // Round totalPrice to whole satoshis to prevent floating-point drift when the
    // value is used for actual payment amounts (e.g. 100 sats/h × 30 min = 49.999…).
    const rawTotal = pricePer5Min * (durationMinutes / 5);
    totalPrice = rawTotal > 0 ? Math.max(1, Math.round(rawTotal)) : 0;
  }

  const pricing = { pricePerHour, pricePer5Min, durationMinutes, totalPrice };
  if (rateInfo) {
    pricing.totalPriceJPY = Math.round(totalPrice * rateInfo.rate);
    pricing.exchangeRateTimestamp = rateInfo.timestamp;
  }
  return pricing;
}

module.exports = { resolvePricePerHour, fetchRateInfo, computeOrderPricing };
