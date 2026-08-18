// public/js/rate.js — exchange-rate cache + sats<->JPY conversion helpers.
// pricePerHour throughout the backend is denominated in satoshis. JPY is
// always a display-only estimate — never sent back to the server, never
// treated as authoritative. rate = JPY per 1 BTC (getBTCtoJPYRate's unit).
import { api } from './api.js';
import { fmtSats, fmtJpy } from './ui.js';

let cached = null; // { rate, timestamp, fetchedAt }
const LOCAL_CACHE_MS = 60_000;

export async function getRate() {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < LOCAL_CACHE_MS) return cached;
  try {
    const data = await api.exchangeRate();
    cached = { rate: data.rate, timestamp: data.timestamp, fetchedAt: now };
    return cached;
  } catch (_err) {
    return cached; // may be null — callers must handle
  }
}

/** 今すぐ返せるレート（キャッシュのみ）。無ければ null。ネットワークを待たない。 */
export function peekRate() {
  return cached;
}

/**
 * 上限つきでレートを待つ。期限までに来なければキャッシュ（無ければ null）を返し、
 * 取得自体はバックグラウンドで走り続ける（次の描画では間に合う）。
 * 一度しか描画しない画面（GPU詳細・注文詳細）で使う。
 * @param {number} ms 待つ上限（ミリ秒）
 */
export function getRateWithin(ms = 1500) {
  return Promise.race([
    getRate(),
    new Promise((resolve) => setTimeout(() => resolve(cached), ms)),
  ]);
}

/**
 * レートを待たずに描画するためのヘルパー。
 *
 * これが無かったために market / gpu-detail / order-detail が
 * `Promise.all([一覧の取得, getRate()])` を待っており、**円換算という
 * 表示上のおまけのために本体の描画が止まっていた**。為替 API は外部依存で、
 * 遅い・落ちることがある。実際 E2E で、一覧は取得できているのに描画が
 * 5 秒を超えて失敗する形で表面化した（ユーザーには「マーケットが開かない」に見える）。
 *
 * 使い方: render(peekRate()) で即描画し、レートが届いたらもう一度 render する。
 * @param {(rateInfo:object|null)=>void} render レート情報を受け取って描画する関数
 */
export function withRate(render) {
  render(peekRate());
  const before = cached;
  getRate().then((info) => {
    // 既に同じものを描画済みなら再描画しない（無駄な DOM 差し替えを避ける）
    if (info === before) return;
    render(info);
  }).catch(() => { /* レート取得の失敗は本体の描画を妨げない */ });
}

export function satsToJpy(sats, rate) {
  if (sats == null || rate == null) return null;
  return (sats / 1e8) * rate;
}

// Renders "1,200 sats/時（約¥18/時）" style text nodes; falls back to sats-only
// if the rate is unavailable (never blocks rendering on a failed rate fetch).
export function priceLine(sats, rateInfo, unitLabel = '') {
  const satsText = `${fmtSats(sats)}${unitLabel}`;
  if (!rateInfo || rateInfo.rate == null) return { sats: satsText, jpy: null };
  const jpy = satsToJpy(sats, rateInfo.rate);
  return { sats: satsText, jpy: `約${fmtJpy(jpy)}${unitLabel}（概算）` };
}
