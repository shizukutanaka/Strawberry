// src/marketplace/spot-tier.js
// Spot / 中断可能インスタンス・ティア（docs/improvement-research-2026 §9）。
// Vast.ai の interruptible インスタンスを参考に、プロバイダ都合の中断を許容する代わりに
// 割引価格で貸すティアを提供する。ここでは価格解決・中断条件・課金計算の純関数のみ;
// I/O は order ルート側が担う。
//
// 中断プロトコル: プロバイダが preempt した時点で注文は 'preempted' へ遷移し、
// preemption.deadlineAt（notice 猶予、既定60s / Vast.ai の 30s〜2分帯）までは借り手が
// チェックポイント退避できる想定。請求は preempt 時点までの実経過時間のみ。

// 中断前通知の猶予（秒）。Vast.ai 系の 30s〜2min レンジに合わせる。
const DEFAULT_SPOT_NOTICE_SEC = 60;
const MIN_NOTICE_SEC = 30;
const MAX_NOTICE_SEC = 600;

// spotEnabled だが価格未指定の場合の既定ディスカウント（Vast.ai spot の 60-90% 割引
// より保守的な 30% off を既定とし、プロバイダは明示価格/割引率で上書き可能）。
const DEFAULT_SPOT_DISCOUNT_PCT = 30;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * GPU の spot 価格を解決する。
 * @returns {{enabled:boolean, pricePerHour:number|null}}
 *   enabled=false、または有効価格が正に解決できなければ pricePerHour=null
 */
function spotPricePerHour(gpu) {
  if (!gpu || gpu.spotEnabled !== true) return { enabled: false, pricePerHour: null };
  const base = Number(gpu.pricePerHour);
  if (!(base > 0)) return { enabled: true, pricePerHour: null };
  const explicit = Number(gpu.spotPricePerHour);
  if (explicit > 0) {
    // spot が通常価格以上なら割引の意味を成さないので base でキャップ
    return { enabled: true, pricePerHour: Math.min(explicit, base) };
  }
  const pct = Number.isFinite(Number(gpu.spotDiscountPct))
    ? clamp(Number(gpu.spotDiscountPct), 1, 95)
    : DEFAULT_SPOT_DISCOUNT_PCT;
  return { enabled: true, pricePerHour: base * (1 - pct / 100) };
}

/**
 * 中断通知オブジェクトを構築。
 * @returns {{requestedAt:string, noticeSec:number, deadlineAt:string, reason:string|null}}
 */
function buildPreemption({ noticeSec, reason, now = new Date() } = {}) {
  const sec = clamp(Number.isFinite(Number(noticeSec)) ? Number(noticeSec) : DEFAULT_SPOT_NOTICE_SEC, MIN_NOTICE_SEC, MAX_NOTICE_SEC);
  return {
    requestedAt: now.toISOString(),
    noticeSec: sec,
    deadlineAt: new Date(now.getTime() + sec * 1000).toISOString(),
    reason: reason || null,
  };
}

/**
 * preempt 時点の請求可能時間（分）。課金粒度は 5 分（既存の pricePer5Min 規則）に切り上げ。
 * startedAt 優先、無ければ scheduledStartAt。予定時間を超えて課金しない。
 */
function chargeableMinutesForPreemption(order, now = new Date()) {
  const startMs = new Date(order.startedAt || order.scheduledStartAt || order.createdAt || now).getTime();
  const duration = Number(order.durationMinutes) || 0;
  if (!Number.isFinite(startMs) || duration <= 0) return 0;
  const elapsedMin = Math.max(0, (now.getTime() - startMs) / 60000);
  return Math.min(duration, Math.ceil(elapsedMin / 5) * 5);
}

/**
 * preempt 時点の最終請求額（sat）。注文の pricePerHour は spot 価格にロック済み。
 * @returns {{chargeableMinutes:number, totalPrice:number, pricePerHour:number}}
 */
function spotSettlement(order, now = new Date()) {
  const pricePerHour = Number(order.pricePerHour) || 0;
  const chargeableMinutes = chargeableMinutesForPreemption(order, now);
  const raw = (pricePerHour / 12) * (chargeableMinutes / 5);
  // order 作成と同じ整数 sat 規則（正の生額は最低 1 sat）
  const totalPrice = raw > 0 ? Math.max(1, Math.round(raw)) : 0;
  return { chargeableMinutes, totalPrice, pricePerHour };
}

/**
 * preempt された注文の代替 GPU 候補（読み取り専用サジェスト。自動再予約はしない）。
 * spotEnabled かつ利用可能で、要求時間帯に blocking 注文が無いもの。元 GPU と同じ
 * model があればそれを優先し、残りは pricePerHour 昇順。
 */
function findSpotAlternatives(order, originalGpu, { gpus, orders, now = new Date(), limit = 3 } = {}) {
  const reqStart = new Date(order.scheduledStartAt || order.createdAt || now).getTime();
  const reqEnd = reqStart + (Number(order.durationMinutes) || 0) * 60000;
  const BLOCKING = new Set(['pending', 'matched', 'active']);
  const taken = new Set(
    (orders || [])
      .filter((o) => BLOCKING.has(o.status))
      .filter((o) => {
        const s = new Date(o.scheduledStartAt || o.createdAt).getTime();
        const e = s + (Number(o.durationMinutes) || 0) * 60000;
        return reqStart < e && reqEnd > s;
      })
      .map((o) => o.gpuId),
  );
  const model = originalGpu && originalGpu.model;
  const candidates = (gpus || [])
    .filter((g) => g.id !== order.gpuId)
    .filter((g) => g.available !== false)
    .filter((g) => spotPricePerHour(g).enabled)
    .filter((g) => !taken.has(g.id));
  const sameModel = model ? candidates.filter((g) => g.model === model) : [];
  const rest = candidates.filter((g) => g.model !== model);
  const byPrice = (a, b) => (spotPricePerHour(a).pricePerHour || Infinity) - (spotPricePerHour(b).pricePerHour || Infinity);
  return [...sameModel.sort(byPrice), ...rest.sort(byPrice)]
    .slice(0, Math.max(0, limit))
    .map((g) => ({ gpuId: g.id, name: g.name, model: g.model, spotPricePerHour: spotPricePerHour(g).pricePerHour }));
}

module.exports = {
  spotPricePerHour,
  buildPreemption,
  chargeableMinutesForPreemption,
  spotSettlement,
  findSpotAlternatives,
  DEFAULT_SPOT_NOTICE_SEC,
  MIN_NOTICE_SEC,
  MAX_NOTICE_SEC,
  DEFAULT_SPOT_DISCOUNT_PCT,
};
