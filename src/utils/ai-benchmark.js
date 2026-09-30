// ai-benchmark.js - HuggingFace API等を用いたAIモデルベンチマーク・推論ユーティリティ
// 各種AIモデルのベンチマークや推論を外部API経由で実行

const axios = require('axios');
const { logger } = require('./logger');

// 外向き HTTP 呼び出しの安全既定値（notifier.js の AXIOS_SAFE_CONFIG と同一値。
// 共有モジュール化は別途 — 両者がドリフトしないよう値は必ず揃えること）。
const SAFE_AXIOS_CONFIG = Object.freeze({
  timeout: 10_000,
  maxContentLength: 1_048_576, // 1MB — HF の大容量応答でメモリ圧迫しない
  maxBodyLength: 1_048_576,
  maxRedirects: 0,
});

// HuggingFace Inference API
async function runHuggingFaceInference(model, inputs, options = {}) {
  const apiKey = options.apiKey || process.env.HF_API_KEY;
  if (!apiKey) throw new Error('HuggingFace APIキー未設定');
  try {
    const res = await axios.post(
      `https://api-inference.huggingface.co/models/${model}`,
      inputs,
      // timeout/maxContentLength/maxRedirects=0: 無指定だと HF の遅延/
      // 大容量応答でプロセスが無期限滞留・メモリ圧迫する。
      { headers: { Authorization: `Bearer ${apiKey}` }, ...SAFE_AXIOS_CONFIG }
    );
    logger.info('HuggingFace推論成功', { model, status: res.status });
    return res.data;
  } catch (err) {
    logger.error('HuggingFace推論失敗', { error: err.message });
    throw err;
  }
}

// ベンチマークAPI呼び出し例（仮想）
async function runAIBenchmark(model, params = {}, options = {}) {
  // ここではHuggingFace推論APIを流用
  return await runHuggingFaceInference(model, params, options);
}

module.exports = {
  runHuggingFaceInference,
  runAIBenchmark,
};
