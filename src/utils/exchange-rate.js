// src/utils/exchange-rate.js - BTC/JPY為替レート取得ユーティリティ
const axios = require('axios');
const { logger } = require('./logger');

// キャッシュ（5分）
let cachedRate = null;
let cachedAt = 0;
const CACHE_DURATION_MS = 5 * 60 * 1000;

// デフォルトレート（障害時フォールバック）
const DEFAULT_RATE = 0.0001; // 1satoshi=0.0001JPY

// 外部為替APIエンドポイント（冗長化）
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=jpy';
const CRYPTOCOMPARE_URL = 'https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=JPY';
const BITFLYER_URL = 'https://api.bitflyer.com/v1/ticker?product_code=BTC_JPY';
const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCJPY';

async function getBTCtoJPYRate(force = false) {
  const now = Date.now();
  if (!force && cachedRate && now - cachedAt < CACHE_DURATION_MS) {
    return cachedRate;
  }
  // 順次フォールバックで複数APIを試行
  const apis = [
    async () => {
      const res = await axios.get(COINGECKO_URL, { timeout: 4000 });
      const btcJpy = res.data?.bitcoin?.jpy;
      if (typeof btcJpy === 'number' && btcJpy > 0) return btcJpy;
      throw new Error('Invalid Coingecko response');
    },
    async () => {
      const res = await axios.get(CRYPTOCOMPARE_URL, { timeout: 4000 });
      const btcJpy = res.data?.JPY;
      if (typeof btcJpy === 'number' && btcJpy > 0) return btcJpy;
      throw new Error('Invalid CryptoCompare response');
    },
    async () => {
      const res = await axios.get(BITFLYER_URL, { timeout: 4000 });
      const btcJpy = res.data?.ltp;
      if (typeof btcJpy === 'number' && btcJpy > 0) return btcJpy;
      throw new Error('Invalid BitFlyer response');
    },
    async () => {
      const res = await axios.get(BINANCE_URL, { timeout: 4000 });
      const btcJpy = parseFloat(res.data?.price);
      if (!isNaN(btcJpy) && btcJpy > 0) return btcJpy;
      throw new Error('Invalid Binance response');
    }
  ];
  for (const api of apis) {
    try {
      const rate = await api();
      if (typeof rate !== 'number' || isNaN(rate)) {
        throw new Error('APIから数値型レートが返されませんでした');
      }
      if (rate < 100000 || rate > 15000000) {
        throw new Error(`レート値が異常範囲: ${rate}`);
      }
      cache.value = rate;
      cache.timestamp = Date.now();
      logger.info(`[exchange-rate] API成功: ${rate}`);
      return rate;
    } catch (err) {
      lastError = err;
      logger.warn(`[exchange-rate] API障害: ${err.message}`);
      continue;
    }
  }
  logger.error('[exchange-rate] 全API障害', { lastError });
  throw lastError || new Error('BTC/JPYレート取得失敗');
}

module.exports = { getBTCtoJPYRate, DEFAULT_RATE };
