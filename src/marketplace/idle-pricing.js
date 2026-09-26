// src/marketplace/idle-pricing.js
// §4(3): GPU 時間は腐敗性財（perishable）— 使われない時間は永遠に失われる。
// プロバイダがオプトインした idleDiscount に基づき、直近の使用終了からの
// 経過時間に比例して実効時給を逓減させる（arXiv:2511.16357 の AMM 簡易版:
// 線形逓減 + 上限キャップ）。
//
// 設計: 純関数。価格自体は書き換えず「実効価格」を返す（basePricePerHour は
// プロバイダ申告値のまま保存）。割引は利用者側のメリットでありプロバイダの
// 意思（opt-in）でのみ発動する。

const DEFAULTS = {
  pctPerHour: 5,      // 空転1時間あたりの割引率（%）
  maxPct: 50,         // 割引率キャップ（%）
  thresholdHours: 1,  // この時間以内の空転は割引なし（直後の再注文を優遇しない）
};

/**
 * 空転割引を適用した実効時給を計算。
 * @param {object} gpu GPU レコード（pricePerHour, idleDiscount?）
 * @param {number|null} lastBusyAtMs 直近の使用終了時刻（注文なしなら null → 登録/更新時刻を空転起点に）
 * @param {number} nowMs
 * @returns {{pricePerHour:number, basePricePerHour:number, discountPct:number, idleHours:number}}
 */
function idleAdjustedPrice(gpu, lastBusyAtMs, nowMs = Date.now()) {
  const base = gpu.pricePerHour;
  const baseResult = { pricePerHour: base, basePricePerHour: base, discountPct: 0, idleHours: 0 };
  const cfg = gpu && gpu.idleDiscount;
  if (!cfg || cfg.enabled !== true || typeof base !== 'number' || base <= 0) return baseResult;

  const pctPerHour = Number.isFinite(cfg.pctPerHour) ? Math.min(Math.max(cfg.pctPerHour, 0), 50) : DEFAULTS.pctPerHour;
  const maxPct = Number.isFinite(cfg.maxPct) ? Math.min(Math.max(cfg.maxPct, 0), 90) : DEFAULTS.maxPct;
  const thresholdHours = Number.isFinite(cfg.thresholdHours) ? Math.min(Math.max(cfg.thresholdHours, 0), 168) : DEFAULTS.thresholdHours;
  if (pctPerHour <= 0 || maxPct <= 0) return baseResult;

  // 空転起点: 直近の使用終了。一度も使われていなければ登録/更新時刻。
  const anchor = typeof lastBusyAtMs === 'number' && Number.isFinite(lastBusyAtMs)
    ? lastBusyAtMs
    : (Date.parse(gpu.updatedAt || gpu.createdAt || 0) || nowMs);
  const idleHours = Math.max(0, (nowMs - anchor) / 3.6e6);
  if (idleHours <= thresholdHours) return { ...baseResult, idleHours: Math.round(idleHours * 100) / 100 };

  const discountPct = Math.min(pctPerHour * (idleHours - thresholdHours), maxPct);
  const effective = Math.round(base * (1 - discountPct / 100) * 10000) / 10000;
  return {
    pricePerHour: effective,
    basePricePerHour: base,
    discountPct: Math.round(discountPct * 100) / 100,
    idleHours: Math.round(idleHours * 100) / 100,
  };
}

/**
 * 注文一覧から GPU ごとの「直近の使用終了時刻」マップを作る。
 * scheduledEndAt がある注文のみ（pending/予約含む全ステータスの最大値 =
 * 保守的: 未来の予約がある限り空転と見なさない）。
 */
function lastBusyAtByGpu(orders) {
  const map = new Map();
  for (const o of orders || []) {
    if (!o.gpuId || !o.scheduledEndAt) continue;
    const end = Date.parse(o.scheduledEndAt);
    if (!Number.isFinite(end)) continue;
    const cur = map.get(o.gpuId);
    if (cur === undefined || end > cur) map.set(o.gpuId, end);
  }
  return map;
}

module.exports = { idleAdjustedPrice, lastBusyAtByGpu, DEFAULTS };
