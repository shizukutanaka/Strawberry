// gpu-price-compare.js - AWS EC2/Azure等クラウドGPU価格API連携
// 外部クラウドのGPU価格を取得し、P2P価格と比較できるユーティリティ

const axios = require('axios');
const { logger } = require('./logger');

// AWS EC2 GPU価格取得（単純な例: public pricing API）
async function fetchAWSEC2GPUPrices(region = 'ap-northeast-1') {
  try {
    // 注意: このエンドポイントの index.json はリージョンの EC2 オファー全体で
    // 非圧縮 1GB 超のサイズになる。axios はレスポンスを全量メモリに展開するため、
    // 上限なしだとプロセスが OOM する。timeout で半開き接続の滞留を防ぎ、
    // maxContentLength で巨大レスポンスをエラーとして扱う（GPU 抽出目的で
    // 全 index を取る実装自体の限界 — 本番利用では price list の差分 API 等へ置き換える）。
    const res = await axios.get(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${region}/index.json`, {
      timeout: 30_000,
      maxContentLength: 256 * 1024 * 1024,
      maxRedirects: 0,
    });
    // 必要なGPUインスタンス情報を抽出
    const gpuInstances = Object.values(res.data.products).filter(p => p.attributes && p.attributes.acceleratorType);
    logger.info('AWS EC2 GPU価格取得成功', { count: gpuInstances.length });
    return gpuInstances;
  } catch (err) {
    logger.error('AWS EC2 GPU価格取得失敗', { error: err.message });
    throw err;
  }
}

// Azure GPU価格取得（仮: 実際はAzure APIや価格ページスクレイピング等）
async function fetchAzureGPUPrices(region = 'japaneast') {
  // TODO: Azure公式APIまたはWebスクレイピング実装
  logger.info('Azure GPU価格取得は未実装');
  return [];
}

module.exports = {
  fetchAWSEC2GPUPrices,
  fetchAzureGPUPrices,
};
