// src/utils/exchange-rate.js - BTC/JPY為替レート取得ユーティリティ
const axios = require('axios');
const { logger } = require('./logger');

// キャッシュ（5分）
let cachedRate = null;
let cachedAt = 0;
const CACHE_DURATION_MS = 5 * 60 * 1000;

// デフォルトレート（障害時フォールバック）
const DEFAULT_RATE = 0.0001; // 1satoshi=0.0001JPY

// Coingecko API（無料・APIキー不要）
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=jpy';

async function getBTCtoJPYRate(force = false) {
  const now = Date.now();
  if (!force && cachedRate && now - cachedAt < CACHE_DURATION_MS) {
    return cachedRate;
  }
  try {
    const res = await axios.get(COINGECKO_URL, { timeout: 5000 });
    const btcJpy = res.data?.bitcoin?.jpy;
    if (typeof btcJpy === 'number' && btcJpy > 0) {
      // 1BTC = btcJpy円 → 1satoshi = btcJpy / 100_000_000
      cachedRate = btcJpy / 100000000;
      cachedAt = now;
      logger.info(`Fetched BTC/JPY rate from Coingecko: 1BTC = ${btcJpy} JPY (1sat = ${cachedRate} JPY)`);
      return cachedRate;
    }
    throw new Error('Invalid response from Coingecko');
  } catch (e) {
    logger.warn('Failed to fetch BTC/JPY rate from Coingecko. Using default rate. Reason: ' + e.message);
    return DEFAULT_RATE;
  }
}

module.exports = { getBTCtoJPYRate, DEFAULT_RATE };
