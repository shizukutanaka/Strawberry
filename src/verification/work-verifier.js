// src/verification/work-verifier.js
// Proof-of-Compute の土台（docs/category-research-2026.md カテゴリ1, 参考: arXiv:2501.05374）。
// 借りた GPU が実際に計算したかを検証するための純関数。utilization-collector.js が使う。
// 再実行監査（shouldAudit）・出力照合（outputsMatch）・ternary consensus は削除した
// （2026-09 第9回点検）。唯一の呼び出し元だった verification-service.js がエスクローごと
// 削除され、同一ジョブを別プロバイダへ再投入する経路もこの製品には存在しないため。
/**
 * ゼロ負荷課金の疑い検出（GPU profiling チェック, arXiv:2501.05374）。
 * ジョブ稼働中に取得した GPU 利用率サンプルが終始ほぼゼロなら「課金されたが実仕事なし」を疑う。
 * utilization-collector.js がハートビートで集めた利用率(%)系列を渡す。
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

module.exports = { detectZeroLoad };
