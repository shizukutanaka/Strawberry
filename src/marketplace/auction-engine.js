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

const DEFAULT_WEIGHTS = { price: 0.45, reputation: 0.35, sla: 0.1, attestation: 0.1, carbon: 0 };

// gCO2eq/kWh。借り手が green 実行を選べる「低炭素系統」の目安
// （水力/原子力主体の系統はおおむね 200 未満、石炭主体は 600+）。
const DEFAULT_GREEN_THRESHOLD = 200;
// カーボン強度を開示しない入札に課す仮定値。世界の系統平均（~480 gCO2eq/kWh）程度に
// やや悲観的に設定し、低炭素の開示者が常に未開示者を上回るようインセンティブを付ける。
const DEFAULT_UNKNOWN_CARBON_INTENSITY = 480;

// 入札の実効カーボン強度（gCO2eq/kWh）。未開示・不正値（負数/NaN）は unknown 既定値。
function carbonIntensityOf(bid, unknownCarbonIntensity) {
  const c = num(bid.carbonIntensity, NaN);
  return c >= 0 ? c : unknownCarbonIntensity;
}

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
 * - carbon      : 系統カーボン強度 gCO2eq/kWh。低いほど高得点。価格と同じ比正規化
 *                 （最低値/intensity）。未開示は unknownCarbonIntensity 仮定値で採点。
 * @returns {{score:number, components:object}}
 */
function scoreBid(bid, { min, minCarbon }, weights, { unknownCarbonIntensity = DEFAULT_UNKNOWN_CARBON_INTENSITY } = {}) {
  const price = num(bid.pricePerHour, min);
  // 価格の正規化（最安値との比。価格<=0 や min<=0 は全員 1.0 として安全化）
  const priceScore = min > 0 && price > 0 ? clamp01(min / price) : 1;
  const reputation = clamp01(num(bid.reputationScore, 0));
  const sla = clamp01(num(bid.slaUptimePct, 100) / 100);
  const attestation = clamp01(num(bid.attestationScore, 0));
  const carbon = carbonIntensityOf(bid, unknownCarbonIntensity);
  // 比正規化は minCarbon>0 のときだけ有効。minCarbon===0（最良が実質ゼロ排出）では
  // ゼロの入札のみ満点とし、それ以外は 0 として区別を残す。
  const carbonScore = minCarbon > 0 ? clamp01(minCarbon / carbon) : (carbon <= 0 ? 1 : 0);

  const score = clamp01(
    weights.price * priceScore +
      weights.reputation * reputation +
      weights.sla * sla +
      weights.attestation * attestation +
      weights.carbon * carbonScore,
  );
  return { score, components: { priceScore, reputation, sla, attestation, carbonScore } };
}

/**
 * 逆オークションを実行する。
 * @param {Array<object>} bids 各入札
 *   { providerId, pricePerHour, reputationScore?, slaUptimePct?, attestationScore?,
 *     attestationPassed?, carbonIntensity?, eligible? }
 * @param {object} opts
 *   reservePrice             … 借り手が許容する最大時給（超過 bid は除外）。未指定で無制限
 *   minReputation            … 最低レピュテーション（未満は除外）。既定 0
 *   requireAttestation       … true なら attestationPassed!==true を除外。既定 false
 *   maxCarbonIntensity       … 許容する最大系統カーボン強度 gCO2eq/kWh（超過は除外。
 *                              未開示は unknown 仮定値で評価されるため実質除外される）。既定無制限
 *   greenThreshold           … ranked 行の green フラグの閾値 gCO2eq/kWh。既定 200
 *   unknownCarbonIntensity   … 未開示 bid の仮定カーボン強度。既定 480
 *   weights                  … {price,reputation,sla,attestation,carbon}（正規化される）
 * @returns {{winner:object|null, ranked:Array, rejected:Array}}
 *   ranked 各行: {providerId, pricePerHour, score, components, carbonIntensity, green}
 *   carbonIntensity は開示値（未開示は null）。green は開示済みかつ閾値以下のとき true。
 */
function runAuction(bids, opts = {}) {
  if (!Array.isArray(bids)) throw new Error('bids must be an array');
  const {
    reservePrice = Infinity,
    minReputation = 0,
    requireAttestation = false,
    maxCarbonIntensity = Infinity,
    greenThreshold = DEFAULT_GREEN_THRESHOLD,
    unknownCarbonIntensity = DEFAULT_UNKNOWN_CARBON_INTENSITY,
    weights: rawWeights = DEFAULT_WEIGHTS,
  } = opts;

  // 重みを正規化（合計が1でなくても安全に）
  const wSum =
    num(rawWeights.price, DEFAULT_WEIGHTS.price) +
    num(rawWeights.reputation, DEFAULT_WEIGHTS.reputation) +
    num(rawWeights.sla, DEFAULT_WEIGHTS.sla) +
    num(rawWeights.attestation, DEFAULT_WEIGHTS.attestation) +
    num(rawWeights.carbon, DEFAULT_WEIGHTS.carbon) || 1;
  const weights = {
    price: num(rawWeights.price, DEFAULT_WEIGHTS.price) / wSum,
    reputation: num(rawWeights.reputation, DEFAULT_WEIGHTS.reputation) / wSum,
    sla: num(rawWeights.sla, DEFAULT_WEIGHTS.sla) / wSum,
    attestation: num(rawWeights.attestation, DEFAULT_WEIGHTS.attestation) / wSum,
    carbon: num(rawWeights.carbon, DEFAULT_WEIGHTS.carbon) / wSum,
  };

  const eligible = [];
  const rejected = [];
  for (const bid of bids) {
    const reasons = [];
    if (bid.eligible === false) reasons.push('marked ineligible');
    // 価格は正の有限数でなければならない。pricePerHour<=0 は scoreBid で priceScore=1.0
    // （最高得点）に化け、同点時の安値優先と相まって「0/負の入札が必ず勝つ」逆オークションの
    // 致命的な操作経路になる。入口で不適格として除外する。
    if (!(num(bid.pricePerHour, 0) > 0)) reasons.push('non-positive price');
    if (num(bid.pricePerHour, Infinity) > reservePrice) reasons.push('over reserve price');
    if (clamp01(num(bid.reputationScore, 0)) < minReputation) reasons.push('below min reputation');
    if (requireAttestation && bid.attestationPassed !== true) reasons.push('attestation required');
    if (carbonIntensityOf(bid, unknownCarbonIntensity) > maxCarbonIntensity) reasons.push('over max carbon intensity');
    if (reasons.length > 0) rejected.push({ providerId: bid.providerId, reasons });
    else eligible.push(bid);
  }

  const bounds = priceBounds(eligible);
  const carbonIntensities = eligible.map((b) => carbonIntensityOf(b, unknownCarbonIntensity));
  const minCarbon = carbonIntensities.length > 0 ? Math.min(...carbonIntensities) : 0;
  const ranked = eligible
    .map((bid) => {
      const { score, components } = scoreBid(bid, { ...bounds, minCarbon }, weights, { unknownCarbonIntensity });
      const disclosed = Number.isFinite(bid.carbonIntensity) && bid.carbonIntensity >= 0 ? bid.carbonIntensity : null;
      const green = disclosed !== null && disclosed <= greenThreshold;
      return { providerId: bid.providerId, pricePerHour: num(bid.pricePerHour), score, components, carbonIntensity: disclosed, green };
    })
    .sort((a, b) => b.score - a.score || a.pricePerHour - b.pricePerHour); // 同点は安い方を優先

  return { winner: ranked[0] || null, ranked, rejected };
}

module.exports = {
  runAuction,
  scoreBid,
  priceBounds,
  carbonIntensityOf,
  DEFAULT_WEIGHTS,
  DEFAULT_GREEN_THRESHOLD,
  DEFAULT_UNKNOWN_CARBON_INTENSITY,
};
