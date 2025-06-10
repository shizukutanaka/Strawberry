// src/utils/exchange-rate.js - BTC/JPY為替レート取得ユーティリティ
const axios = require('axios');
const { logger } = require('./logger');
const { appendAuditLog } = require('./audit-log');
// Prometheusメトリクス
let client;
try {
  client = require('prom-client');
} catch {}
const exchangeRateSuccessCounter = client ? new client.Counter({ name: 'exchange_rate_fetch_success_total', help: 'Total successful exchange rate fetches' }) : { inc: () => {} };
const exchangeRateFailureCounter = client ? new client.Counter({ name: 'exchange_rate_fetch_failure_total', help: 'Total failed exchange rate fetches' }) : { inc: () => {} };
const exchangeRateFetchDuration = client ? new client.Histogram({ name: 'exchange_rate_fetch_duration_seconds', help: 'Exchange rate fetch duration (seconds)' }) : { startTimer: () => () => {} };
const exchangeRateCacheHitCounter = client ? new client.Counter({ name: 'exchange_rate_cache_hit_total', help: 'Total exchange rate cache hits' }) : { inc: () => {} };
const exchangeRateCacheMissCounter = client ? new client.Counter({ name: 'exchange_rate_cache_miss_total', help: 'Total exchange rate cache misses' }) : { inc: () => {} };

// 外部通知hook（service-monitor.jsのものを流用）
let notifyExternalAlert = async () => {};
try {
  notifyExternalAlert = require('../core/service-monitor').notifyExternalAlert || notifyExternalAlert;
} catch {}

// キャッシュ（5分）
let cache = { rate: null, timestamp: 0 };
const CACHE_MS = 5 * 60 * 1000;

// デフォルトレート（障害時フォールバック）
const DEFAULT_RATE = 0.0001; // 1satoshi=0.0001JPY

// 外部為替APIエンドポイント（冗長化）
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=jpy';
const CRYPTOCOMPARE_URL = 'https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=JPY';
const BITFLYER_URL = 'https://api.bitflyer.com/v1/ticker?product_code=BTC_JPY';
const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCJPY';

/**
 * BTC→JPYレート取得
 * @param {boolean} force - キャッシュ無視して強制取得
 * @param {boolean} withTimestamp - 取得時刻も返す場合true
 * @returns {number|{rate:number,timestamp:number}}
 */
async function getBTCtoJPYRate(force = false, withTimestamp = false) {
  const endTimer = exchangeRateFetchDuration.startTimer();
  const now = Date.now();
  if (!force && cache.rate && now - cache.timestamp < CACHE_MS) {
    // キャッシュヒット
    exchangeRateCacheHitCounter.inc();
    exchangeRateSuccessCounter.inc();
    endTimer();
    if (withTimestamp) {
      return { rate: cache.rate, timestamp: cache.timestamp, isCache: true };
    }
    return cache.rate;
  }
  // キャッシュミス
  exchangeRateCacheMissCounter.inc();
  let lastError = null;
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
      cache.rate = rate;
      cache.timestamp = Date.now();
      exchangeRateSuccessCounter.inc();
      endTimer();
      if (withTimestamp) {
        return { rate, timestamp: cache.timestamp };
      }
      return rate;
    } catch (err) {
      logger.error('Exchange rate fetch failed:', err);
      exchangeRateFailureCounter.inc();
      lastError = err;
      appendAuditLog('exchange_rate_fetch_failure', { error: err.message });
      try { await notifyExternalAlert('exchange_rate_fetch_failure', { error: err.message }); } catch {}
    }
  }
  logger.warn('All exchange rate APIs failed, using default rate');
  appendAuditLog('exchange_rate_fallback', { fallback: DEFAULT_RATE });
  try { await notifyExternalAlert('exchange_rate_fallback', { fallback: DEFAULT_RATE }); } catch {}
  endTimer();
  if (withTimestamp) {
    return { rate: DEFAULT_RATE, timestamp: Date.now() };
  }
  return DEFAULT_RATE;
}

module.exports = { getBTCtoJPYRate, DEFAULT_RATE };
