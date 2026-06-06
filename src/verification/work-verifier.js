// src/verification/work-verifier.js
// Proof-of-Compute の土台（docs/category-research-2026.md カテゴリ1, 参考: arXiv:2501.05374）。
// インフラ不要・依存ライトな純関数群。借りた GPU が実際に計算したかを検証するための部品で、
// マッチング/決済(エスクロー解放)・レピュテーション更新から呼び出すことを想定。
const crypto = require('crypto');

/**
 * ジョブ単位の再実行監査サンプラ（決定論的）。
 * 一定確率で同一ジョブを別プロバイダへ再投入し出力照合する＝「無労働で課金」を抑止。
 * jobId をシードにするため監査要否は再現可能（事後検証できる）。
 * @param {string} jobId
 * @param {{auditRate?: number}} opts auditRate ∈ [0,1]
 * @returns {boolean}
 */
function shouldAudit(jobId, { auditRate = 0.1 } = {}) {
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new Error('jobId must be a non-empty string');
  }
  if (!(auditRate >= 0 && auditRate <= 1)) {
    throw new Error('auditRate must be within [0,1]');
  }
  if (auditRate === 0) return false;
  if (auditRate === 1) return true;
  const hex = crypto.createHash('sha256').update(jobId).digest('hex').slice(0, 8);
  const frac = parseInt(hex, 16) / 0x100000000; // [0,1)
  return frac < auditRate;
}

/**
 * 2つのジョブ出力の一致判定。
 * GPU 計算はプロバイダ間で非決定的なため、数値（およびネスト配列）は相対許容誤差で比較し、
 * それ以外（文字列ハッシュ等）は厳密比較する。
 * @param {*} a
 * @param {*} b
 * @param {{tolerance?: number}} opts
 * @returns {boolean}
 */
function outputsMatch(a, b, { tolerance = 1e-3 } = {}) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!outputsMatch(a[i], b[i], { tolerance })) return false;
    }
    return true;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    const denom = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) / denom <= tolerance;
  }
  return a === b;
}

/**
 * ≥3 プロバイダ出力に対する ternary consensus（信頼ノード不要の合意, arXiv:2501.05374）。
 * 許容誤差で出力をクラスタリングし、過半数クラスタを「合意値」とする。少数派は dissenter。
 * @param {Array<*>} outputs
 * @param {{tolerance?: number}} opts
 * @returns {{agreed: boolean, value: *, majority: number[], dissenters: number[]}}
 */
function ternaryConsensus(outputs, opts = {}) {
  if (!Array.isArray(outputs) || outputs.length < 3) {
    throw new Error('ternaryConsensus requires at least 3 outputs');
  }
  const clusters = []; // { value, members: number[] }
  outputs.forEach((o, idx) => {
    const c = clusters.find((cl) => outputsMatch(cl.value, o, opts));
    if (c) c.members.push(idx);
    else clusters.push({ value: o, members: [idx] });
  });
  clusters.sort((x, y) => y.members.length - x.members.length);
  const top = clusters[0];
  const agreed = top.members.length > outputs.length / 2;
  const dissenters = agreed
    ? outputs.map((_, i) => i).filter((i) => !top.members.includes(i))
    : [];
  return {
    agreed,
    value: agreed ? top.value : null,
    majority: top.members,
    dissenters,
  };
}

/**
 * ゼロ負荷課金の疑い検出（GPU profiling チェック, arXiv:2501.05374）。
 * ジョブ稼働中に取得した GPU 利用率サンプルが終始ほぼゼロなら「課金されたが実仕事なし」を疑う。
 * `src/gpu/gpu-metrics.js` 等で集めた利用率(%)系列を渡す想定。
 * @param {number[]} utilSamples 利用率(%)サンプル列
 * @param {{minUtilPct?: number, minActiveRatio?: number}} opts
 * @returns {{suspectedZeroLoad: boolean, activeRatio: number, samples: number}}
 */
function detectZeroLoad(utilSamples, { minUtilPct = 5, minActiveRatio = 0.2 } = {}) {
  if (!Array.isArray(utilSamples) || utilSamples.length === 0) {
    throw new Error('utilSamples must be a non-empty array');
  }
  const active = utilSamples.filter((u) => typeof u === 'number' && u >= minUtilPct).length;
  const activeRatio = active / utilSamples.length;
  return {
    suspectedZeroLoad: activeRatio < minActiveRatio,
    activeRatio,
    samples: utilSamples.length,
  };
}

module.exports = { shouldAudit, outputsMatch, ternaryConsensus, detectZeroLoad };
