// src/marketplace/spot-tier.js
// Spot（中断許容）ティアのポリシー（docs/improvement-research-2026.md §9 / カテゴリ7）。
//
// 現状の Strawberry は固定時間枠の専有レンタルしか売れない。プロバイダは「1時間だけ空くが
// 3時間の予約は受けられない」余剰を現金化できず、借り手は中断を許容する代わりに安く借りる
// 選択肢を持てない。GPU 時間は貯蔵不能な腐敗性財なので、この取りこぼしは丸ごと損失になる。
//
// 同種ソフト: Vast.ai の interruptible インスタンスは入札制で最大 80% 安。一般に spot は
// 60〜90% 割引で、30秒〜2分前に中断通知が出る。
//
// 参考研究:
// - Bamboo: Making Preemptible Instances Resilient for Affordable Training of Large DNNs,
//   arXiv:2204.12013 — 素朴なチェックポイントだと GPT-2/64 spot で**再起動に 77% の時間**を
//   浪費する。つまり「安いから中断してよい」だけでは使い物にならず、**中断前の猶予**が
//   ティアの実用性を決める。本モジュールが猶予窓（notice → deadline）を一級の概念として
//   持つのはこのため。
// - TierCheck: Tiered Checkpointing for Fault Tolerance in LLM Training, arXiv:2605.17821 —
//   local/neighbor/remote の三層チェックポイント。猶予窓で何を退避すべきかの設計指針。
// - Modeling The Temporally Constrained Preemptions of Transient Cloud VMs, arXiv:1911.05160。
//
// 本モジュールは純関数のみ・依存ゼロ。中断の「実行」（コンテナ停止等）は扱わず、
// 価格・猶予・精算比率という**約束の条件**だけを決める。

const SPOT_DEFAULTS = {
  // 既定割引率(%)。Vast.ai 等の実勢（60〜90%安）より保守的に置く。プロバイダが上げ下げできる。
  discountPct: 40,
  // 割引率の許容範囲。0% は「spot なのに安くない」= 借り手に中断リスクだけ負わせる詐欺的な
  // 出品になるため下限を設ける。100% 近くは事実上の無償提供で、誤設定の方が疑わしいため上限も設ける。
  minDiscountPct: 10,
  maxDiscountPct: 90,
  // 中断通知から実際の停止までの猶予（秒）。Bamboo が示すとおり、猶予ゼロの中断は
  // 借り手の計算を丸ごと捨てさせる。実勢（30秒〜2分）の上限側を既定にする。
  noticeSeconds: 120,
  minNoticeSeconds: 30,
  maxNoticeSeconds: 900,
};

const TIERS = Object.freeze({ ONDEMAND: 'ondemand', SPOT: 'spot' });

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** ティア文字列を正規化する（未指定・不明は ondemand）。 */
function normalizeTier(tier) {
  return tier === TIERS.SPOT ? TIERS.SPOT : TIERS.ONDEMAND;
}

/**
 * 出品の spot 設定を検証・正規化する。
 * @param {object} gpu { spotEnabled, spotDiscountPct, spotNoticeSeconds }
 * @returns {{enabled:boolean, discountPct:number, noticeSeconds:number}}
 */
function resolveSpotConfig(gpu = {}) {
  const enabled = gpu.spotEnabled === true;
  const rawDiscount = num(gpu.spotDiscountPct);
  const rawNotice = num(gpu.spotNoticeSeconds);
  return {
    enabled,
    discountPct: clamp(
      rawDiscount == null ? SPOT_DEFAULTS.discountPct : rawDiscount,
      SPOT_DEFAULTS.minDiscountPct,
      SPOT_DEFAULTS.maxDiscountPct
    ),
    noticeSeconds: clamp(
      rawNotice == null ? SPOT_DEFAULTS.noticeSeconds : rawNotice,
      SPOT_DEFAULTS.minNoticeSeconds,
      SPOT_DEFAULTS.maxNoticeSeconds
    ),
  };
}

/**
 * ティアに応じた実効時給を返す。
 * @param {number} pricePerHour 出品の定価（sats/時）
 * @param {string} tier
 * @param {object} gpu spot 設定の載った出品レコード
 * @returns {{pricePerHour:number, tier:string, discountPct:number, listPricePerHour:number}}
 */
function effectivePrice(pricePerHour, tier, gpu = {}) {
  const list = num(pricePerHour);
  if (list == null || list <= 0) throw new Error('pricePerHour must be a positive number');
  const t = normalizeTier(tier);
  if (t !== TIERS.SPOT) {
    return { pricePerHour: list, tier: TIERS.ONDEMAND, discountPct: 0, listPricePerHour: list };
  }
  const cfg = resolveSpotConfig(gpu);
  // 呼び出し側が spotEnabled を検査せずここへ来た場合に黙って割引を与えないよう、
  // 無効なら例外にする（「spot 価格で借りたのに中断されない」より「設定漏れが見える」方がよい）。
  if (!cfg.enabled) throw new Error('this GPU does not offer the spot tier');
  const discounted = list * (1 - cfg.discountPct / 100);
  return {
    // sats は整数が最小単位。割引で 0 に潰れると「無料レンタル」かつ支払い不能になるため 1 で下限を切る。
    pricePerHour: Math.max(1, Math.round(discounted)),
    tier: TIERS.SPOT,
    discountPct: cfg.discountPct,
    listPricePerHour: list,
  };
}

/**
 * 中断通知の内容を組み立てる。
 * @param {object} gpu 出品（猶予秒の設定元）
 * @param {number} nowMs
 * @returns {{noticeAt:string, deadlineAt:string, noticeSeconds:number}}
 */
function buildPreemptionNotice(gpu = {}, nowMs = Date.now()) {
  const { noticeSeconds } = resolveSpotConfig(gpu);
  return {
    noticeAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + noticeSeconds * 1000).toISOString(),
    noticeSeconds,
  };
}

/**
 * 中断された注文の精算入力を求める。
 *
 * **最低課金を効かせない**のが要点。settlement-calculator の既定は「即時解約でも総額の 10% は
 * 課金」（セットアップ費の考え方）だが、これは*借り手都合*の解約を前提にした floor である。
 * プロバイダ都合の中断にこれを適用すると、「受注 → 即中断 → 最低課金だけ回収」を繰り返す
 * ゼロワーク課金が成立してしまう（/stop がプロバイダに禁止されているのと同じ理由の穴）。
 * したがって中断時は minChargeRatio=0 とし、借り手は実際に提供された時間の分だけ支払う。
 *
 * @param {object} order { startedAt, durationMinutes }
 * @param {number} preemptedAtMs 実際に停止した時刻
 * @returns {{usage:{deliveredRatio:number, slaUptimePct:number}, opts:{minChargeRatio:number}, deliveredSeconds:number}}
 */
function preemptionSettlement(order = {}, preemptedAtMs = Date.now()) {
  const durationSeconds = Math.max(0, (num(order.durationMinutes) || 0) * 60);
  const startedMs = order.startedAt ? new Date(order.startedAt).getTime() : NaN;
  const deliveredSeconds = Number.isFinite(startedMs)
    ? Math.max(0, (preemptedAtMs - startedMs) / 1000)
    : 0;
  const deliveredRatio = durationSeconds > 0
    ? clamp(deliveredSeconds / durationSeconds, 0, 1)
    : 0;
  return {
    deliveredSeconds,
    usage: {
      deliveredRatio,
      // 中断は SLA 違反ではない（ティアの仕様どおりの動作）。SLA ペナルティを課すと
      // 「約束どおり中断したプロバイダ」を罰することになる。可視化は preemptionRate で行う。
      slaUptimePct: 100,
    },
    opts: { minChargeRatio: 0 },
  };
}

/**
 * プロバイダの中断率を注文履歴から導出する。
 *
 * 新しい永続化は増やさない（GPU レーティングを注文から導くのと同じ方針）。中断は SLA 違反
 * として減点しない代わりに、**借り手が選べるよう必ず開示する**。「安いが中断される」ことと
 * 「約束を破る」ことは別で、前者を隠すと spot ティアは信頼できない商品になる。
 *
 * @param {Array<object>} orders そのプロバイダの注文（全ティア）
 * @param {object} opts { minSamples } サンプル不足時は率を出さない
 * @returns {{rate:number|null, preempted:number, spotOrders:number, measuring:boolean}}
 */
function preemptionRate(orders = [], { minSamples = 5 } = {}) {
  const spotOrders = orders.filter((o) => o && normalizeTier(o.tier) === TIERS.SPOT);
  const finished = spotOrders.filter((o) => o.status === 'completed' || o.status === 'cancelled');
  const preempted = finished.filter((o) => o.terminationReason === 'preempted').length;
  if (finished.length < minSamples) {
    return { rate: null, preempted, spotOrders: finished.length, measuring: finished.length > 0 };
  }
  return {
    rate: Math.round((preempted / finished.length) * 1000) / 1000,
    preempted,
    spotOrders: finished.length,
    measuring: false,
  };
}

module.exports = {
  TIERS,
  SPOT_DEFAULTS,
  normalizeTier,
  resolveSpotConfig,
  effectivePrice,
  buildPreemptionNotice,
  preemptionSettlement,
  preemptionRate,
};
