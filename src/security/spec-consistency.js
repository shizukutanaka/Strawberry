// src/security/spec-consistency.js
// §2(短期): プロバイダ申告スペック（claimed）と署名付きベンチマーク実測
// （measured）の乖離をスコア化する純関数。スペック詐称（安価GPUをH100と偽る等）
// の検知を attestation 層と独立に行う — リモートアテステーション非対応 GPU でも
// 実測ベンチマークの乖離から兆候を掴める。
//
// 設計: 各指標の相対偏差 pct = |measured - claimed| / claimed を算出し、
// 重み付けで合成。ただし「過申告」（measured << claimed）は詐称、
// 「控えめ申告」（measured >> claimed）は利用者に有利なため半分の重みで評価する
// （over-report には重い係数、under-report には軽い係数を掛ける）。

const DEFAULTS = {
  // 各指標の許容偏差（表示差異・計測ばらつきの範囲）
  tolerance: { memoryGB: 0.05, teraflops: 0.15, benchmarkScore: 0.15, clockMHz: 0.05 },
  // 詐称方向（over-report: measured < claimed）は過少評価方向より重く罰する
  overReportWeight: 1.0,
  underReportWeight: 0.35,
  // ラベル閾値（重み付け平均偏差）
  suspiciousThreshold: 0.25,
  spoofedThreshold: 0.5,
  maxAgeSec: 24 * 3600, // ベンチレポート有効期限 24h（ベンチは変動しにくい）
};

const METRIC_WEIGHTS = { modelMatch: 3, memoryGB: 2, teraflops: 2, benchmarkScore: 2, clockMHz: 1 };

/**
 * 申告スペックと実測ベンチマークの乖離をスコア化。
 * @param {object} claimed {model, vendor, memoryGB, clockMHz, performance:{teraflops,benchmarkScore}}
 * @param {object} measured {model, memoryGB, teraflops, benchmarkScore, clockMHz, timestamp, signature}
 * @returns {{score:number, label:string, deviations:object, findings:string[]}|null}
 *   measured が null/非オブジェクト、または比較可能な指標が1つも無いときは null。
 */
function scoreSpecConsistency(claimed = {}, measured = null, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!measured || typeof measured !== 'object') return null;

  const findings = [];
  const deviations = {};
  let weightedSum = 0;
  let weightTotal = 0;

  // モデル名一致（正規化: 大小無視・ベンダー接頭辞除去）
  const norm = (s) => String(s || '').toLowerCase().replace(/\b(nvidia|geforce|amd|radeon|tesla)\b/g, '').replace(/[^a-z0-9]/g, '');
  const cModel = norm(claimed.model);
  const mModel = norm(measured.model);
  if (cModel && mModel) {
    const ok = cModel === mModel || cModel.includes(mModel) || mModel.includes(cModel);
    deviations.modelMatch = ok;
    weightedSum += (ok ? 0 : 1) * METRIC_WEIGHTS.modelMatch;
    weightTotal += METRIC_WEIGHTS.modelMatch;
    if (!ok) findings.push(`model mismatch: claimed="${claimed.model}", measured="${measured.model}"`);
  }

  const metric = (key, claimedVal, measuredVal) => {
    if (typeof claimedVal !== 'number' || typeof measuredVal !== 'number' ||
        !Number.isFinite(claimedVal) || !Number.isFinite(measuredVal) || claimedVal <= 0) return;
    const raw = (measuredVal - claimedVal) / claimedVal;
    const over = raw < 0; // measured < claimed = 過申告（詐称方向）
    const dev = Math.abs(raw) * (over ? cfg.overReportWeight : cfg.underReportWeight);
    deviations[key] = { claimed: claimedVal, measured: measuredVal, pct: Math.round(raw * 1000) / 10, direction: over ? 'over' : 'under' };
    weightedSum += dev * METRIC_WEIGHTS[key];
    weightTotal += METRIC_WEIGHTS[key];
    const tol = cfg.tolerance[key] || 0.1;
    if (over && Math.abs(raw) > tol) {
      findings.push(`${key} over-reported: claimed=${claimedVal}, measured=${measuredVal} (${(Math.abs(raw) * 100).toFixed(1)}% less)`);
    }
  };

  metric('memoryGB', claimed.memoryGB, measured.memoryGB);
  metric('teraflops', claimed.performance && claimed.performance.teraflops, measured.teraflops);
  metric('benchmarkScore', claimed.performance && claimed.performance.benchmarkScore, measured.benchmarkScore);
  metric('clockMHz', claimed.clockMHz, measured.clockMHz);

  if (weightTotal === 0) return null; // 比較可能な指標なし

  // 署名の存在はスコア本体ではなく finding として扱う（無署名実測は信頼度低）
  if (typeof measured.signature !== 'string' || measured.signature.length < 8) {
    findings.push('benchmark report unsigned — consistency score is informational only');
  }
  if (measured.timestamp) {
    const ageMs = Date.now() - new Date(measured.timestamp).getTime();
    if (ageMs < 0 || ageMs > cfg.maxAgeSec * 1000) {
      findings.push(`benchmark report stale: age=${Math.round(ageMs / 1000)}s`);
    }
  }

  const score = Math.max(0, Math.min(1, 1 - weightedSum / weightTotal));
  const label =
    score >= 1 - cfg.suspiciousThreshold ? 'consistent'
    : score >= 1 - cfg.spoofedThreshold ? 'divergent'
    : 'suspicious';
  return { score: Math.round(score * 1000) / 1000, label, deviations, findings };
}

module.exports = { scoreSpecConsistency, DEFAULTS, METRIC_WEIGHTS };
