// src/marketplace/auction-engine.js
// 逆オークション（reverse auction）によるマッチング・エンジン。
// docs/SPECIFICATION.md F1.3「マッチング: 単純検索/ソート … 🟡 オークション/レピュテーション
// 重み無し」を埋める。Akash（プロバイダが deployment に入札し競争）/ Golem の中核機構を、
// 価格・レピュテーション・SLA・アテステーションを統合した単一効用スコアで実装する純関数。
//
// 借り手は要件（GPU スペック・予算上限 reservePrice・各因子の重み）を提示し、
// 複数プロバイダが入札（bid）する。エンジンは不適格な入札を除外し、残りを
// 効用スコア降順に並べ、勝者を選ぶ。インフラ非依存・決定論的・テスト可能。

function num(v, def = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

const DEFAULT_WEIGHTS = { price: 0.45, reputation: 0.35, sla: 0.1, attestation: 0.1 };

/**
 * 入札集合から価格の正規化に使う最小・最大を求める（0除算/同値を安全化）。
 */
function priceBounds(bids) {
  const prices = bids.map((b) => num(b.pricePerHour, Infinity)).filter((p) => Number.isFinite(p));
  if (prices.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

/**
 * 1 入札の効用スコアを算出する。
 * - price       : 安いほど高得点。最安値との比 min/price で正規化（最安=1.0）。
 *                 min-max 正規化と違い、わずかな価格差を 0/1 に増幅せず、相対的な
 *                 割高度を保つ（逆オークションの標準的な price-ratio 法）。
 * - reputation  : [0,1] のレピュテーションスコアをそのまま
 * - sla         : 稼働率(%)/100
 * - attestation : アテステーション score（未提供は 0）
 * @returns {{score:number, components:object}}
 */
function scoreBid(bid, { min }, weights) {
  const price = num(bid.pricePerHour, min);
  // 価格の正規化（最安値との比。価格<=0 や min<=0 は全員 1.0 として安全化）
  const priceScore = min > 0 && price > 0 ? clamp01(min / price) : 1;
  const reputation = clamp01(num(bid.reputationScore, 0));
  const sla = clamp01(num(bid.slaUptimePct, 100) / 100);
  const attestation = clamp01(num(bid.attestationScore, 0));

  const score = clamp01(
    weights.price * priceScore +
      weights.reputation * reputation +
      weights.sla * sla +
      weights.attestation * attestation,
  );
  return { score, components: { priceScore, reputation, sla, attestation } };
}

/**
 * 逆オークションを実行する。
 * @param {Array<object>} bids 各入札
 *   { providerId, pricePerHour, reputationScore?, slaUptimePct?, attestationScore?,
 *     attestationPassed?, eligible? }
 * @param {object} opts
 *   reservePrice         … 借り手が許容する最大時給（超過 bid は除外）。未指定で無制限
 *   minReputation        … 最低レピュテーション（未満は除外）。既定 0
 *   requireAttestation   … true なら attestationPassed!==true を除外。既定 false
 *   weights              … {price,reputation,sla,attestation}（正規化される）
 * @returns {{winner:object|null, ranked:Array, rejected:Array}}
 */
function runAuction(bids, opts = {}) {
  if (!Array.isArray(bids)) throw new Error('bids must be an array');
  const {
    reservePrice = Infinity,
    minReputation = 0,
    requireAttestation = false,
    weights: rawWeights = DEFAULT_WEIGHTS,
  } = opts;

  // 重みを正規化（合計が1でなくても安全に）
  const wSum =
    num(rawWeights.price, DEFAULT_WEIGHTS.price) +
    num(rawWeights.reputation, DEFAULT_WEIGHTS.reputation) +
    num(rawWeights.sla, DEFAULT_WEIGHTS.sla) +
    num(rawWeights.attestation, DEFAULT_WEIGHTS.attestation) || 1;
  const weights = {
    price: num(rawWeights.price, DEFAULT_WEIGHTS.price) / wSum,
    reputation: num(rawWeights.reputation, DEFAULT_WEIGHTS.reputation) / wSum,
    sla: num(rawWeights.sla, DEFAULT_WEIGHTS.sla) / wSum,
    attestation: num(rawWeights.attestation, DEFAULT_WEIGHTS.attestation) / wSum,
  };

  const eligible = [];
  const rejected = [];
  for (const bid of bids) {
    const reasons = [];
    if (bid.eligible === false) reasons.push('marked ineligible');
    if (num(bid.pricePerHour, Infinity) > reservePrice) reasons.push('over reserve price');
    if (clamp01(num(bid.reputationScore, 0)) < minReputation) reasons.push('below min reputation');
    if (requireAttestation && bid.attestationPassed !== true) reasons.push('attestation required');
    if (reasons.length > 0) rejected.push({ providerId: bid.providerId, reasons });
    else eligible.push(bid);
  }

  const bounds = priceBounds(eligible);
  const ranked = eligible
    .map((bid) => {
      const { score, components } = scoreBid(bid, bounds, weights);
      return { providerId: bid.providerId, pricePerHour: num(bid.pricePerHour), score, components };
    })
    .sort((a, b) => b.score - a.score || a.pricePerHour - b.pricePerHour); // 同点は安い方を優先

  return { winner: ranked[0] || null, ranked, rejected };
}

module.exports = { runAuction, scoreBid, priceBounds, DEFAULT_WEIGHTS };
