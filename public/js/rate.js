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
