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
// stale-while-revalidate: 期限切れキャッシュを即返ししつつ裏で更新した回数。
// 「注文作成等のホットパスが外部APIレイテンシから切り離されて動いた」件数を可視化する。
const exchangeRateStaleServeCounter = client ? new client.Counter({ name: 'exchange_rate_stale_serve_total', help: 'Total times a stale cached rate was served while revalidating in the background' }) : { inc: () => {} };

// 外部通知hook（service-monitor.jsのものを流用）
let notifyExternalAlert = async () => {};
try {
  notifyExternalAlert = require('../core/service-monitor').notifyExternalAlert || notifyExternalAlert;
} catch {}

// キャッシュ（5分）
let cache = { rate: null, timestamp: 0 };
const CACHE_MS = 5 * 60 * 1000;

// デフォルトレート（全API障害かつキャッシュ皆無時の最終フォールバック）。
// 単位はライブ取得値と同じ「1 BTC あたりの JPY」。検証レンジ [100000, 15000000] の
// 範囲内に置く。旧値 0.0001 は単位（JPY/satoshi）が混在しており、障害時に注文の
// JPY 表示がほぼ 0 に潰れる重大バグだったため是正。なお下の取得ロジックは、まず
// 期限切れキャッシュ（直近の実レート）を優先し、本定数は本当に最後の手段とする。
const DEFAULT_RATE = 10000000; // 1 BTC = 10,000,000 JPY（粗いアウテージ用フォールバック）

// 外部為替APIエンドポイント（冗長化）
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=jpy';
const CRYPTOCOMPARE_URL = 'https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=JPY';
const BITFLYER_URL = 'https://api.bitflyer.com/v1/ticker?product_code=BTC_JPY';
const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCJPY';

function _formatReturn(rate, timestamp, isCache, withTimestamp) {
  if (withTimestamp) return { rate, timestamp, isCache };
  return rate;
}

// 順次フォールバックで複数の外部APIを試行し、最初に成功した妥当なレートで
// キャッシュを更新して返す。全API失敗時は最後のエラーを throw する。
// 同期パス（cold/force）とバックグラウンド更新の双方から共有する。
async function _fetchFreshRate() {
  // テスト環境では短いタイムアウトを使い、すべて失敗した場合に素早くフォールバック
  const API_TIMEOUT = process.env.NODE_ENV === 'test' ? 500 : 4000;
  const apis = [
    async () => {
      const res = await axios.get(COINGECKO_URL, { timeout: API_TIMEOUT });
      const btcJpy = res.data?.bitcoin?.jpy;
      if (typeof btcJpy === 'number' && btcJpy > 0) return btcJpy;
      throw new Error('Invalid Coingecko response');
    },
    async () => {
      const res = await axios.get(CRYPTOCOMPARE_URL, { timeout: API_TIMEOUT });
      const btcJpy = res.data?.JPY;
      if (typeof btcJpy === 'number' && btcJpy > 0) return btcJpy;
      throw new Error('Invalid CryptoCompare response');
    },
    async () => {
      const res = await axios.get(BITFLYER_URL, { timeout: API_TIMEOUT });
      const btcJpy = res.data?.ltp;
      if (typeof btcJpy === 'number' && btcJpy > 0) return btcJpy;
      throw new Error('Invalid BitFlyer response');
    },
    async () => {
      const res = await axios.get(BINANCE_URL, { timeout: API_TIMEOUT });
      const btcJpy = parseFloat(res.data?.price);
      if (!isNaN(btcJpy) && btcJpy > 0) return btcJpy;
      throw new Error('Invalid Binance response');
    }
  ];
  let lastError = null;
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
      return rate;
    } catch (err) {
      logger.error('Exchange rate fetch failed:', err);
      exchangeRateFailureCounter.inc();
      lastError = err;
      try { appendAuditLog('exchange_rate_fetch_failure', { error: err.message }); } catch {}
      try { await notifyExternalAlert('exchange_rate_fetch_failure', { error: err.message }); } catch {}
    }
  }
  throw lastError || new Error('All exchange rate APIs failed');
}

// バックグラウンド更新（重複実行を1本に集約）。stale なキャッシュを即返しした
// リクエストがトリガーする。失敗しても stale 値の提供を継続するため、エラーは
// ここで握りつぶし呼び出し元へ伝播させない（fire-and-forget）。
let _refreshInFlight = null;
function _backgroundRefresh() {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = _fetchFreshRate()
    .catch((err) => {
      logger.warn(`Background exchange rate refresh failed (serving stale): ${err && err.message}`);
    })
    .finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}

/**
 * BTC→JPYレート取得
 * @param {boolean} force - キャッシュ無視して強制取得
 * @param {boolean} withTimestamp - 取得時刻も返す場合true
 * @returns {number|{rate:number,timestamp:number,isCache:boolean}}
 */
async function getBTCtoJPYRate(force = false, withTimestamp = false) {
  const endTimer = exchangeRateFetchDuration.startTimer();
  const now = Date.now();
  const hasCache = cache.rate != null;
  const isFresh = hasCache && now - cache.timestamp < CACHE_MS;

  // 1. フレッシュなキャッシュ（TTL内）: 即返し。
  if (!force && isFresh) {
    exchangeRateCacheHitCounter.inc();
    exchangeRateSuccessCounter.inc();
    endTimer();
    return _formatReturn(cache.rate, cache.timestamp, true, withTimestamp);
  }

  // 2. stale-while-revalidate: 期限切れだが値が存在する場合、stale 値を即返しし、
  //    バックグラウンドで更新する（重複集約）。これにより注文作成・一覧・支払い等の
  //    ホットパスが外部レートAPIのレイテンシから切り離される。旧実装はTTL満了直後の
  //    最初のリクエストが4本のAPIを順次待ち（全タイムアウト時は最大16秒）ブロックしていた。
  if (!force && hasCache) {
    exchangeRateStaleServeCounter.inc();
    exchangeRateCacheHitCounter.inc();
    exchangeRateSuccessCounter.inc();
    _backgroundRefresh(); // fire-and-forget（重複集約・エラーは内部で握りつぶす）
    endTimer();
    return _formatReturn(cache.rate, cache.timestamp, true, withTimestamp);
  }

  // 3. コールドキャッシュ or force=true: 同期でフェッチする。
  exchangeRateCacheMissCounter.inc();
  try {
    const rate = await _fetchFreshRate();
    endTimer();
    return _formatReturn(rate, cache.timestamp, false, withTimestamp);
  } catch (_err) {
    // 全API失敗 — 以下のフォールバックへ
  }

  // stale-while-error: 期限切れでも直近の実レートがあれば、捏造した定数より優先する。
  // 5分古い実レートの方が、単位の異なる固定値より遥かに安全（金額表示の妥当性を保つ）。
  // （force=true で fetch 失敗したが古いキャッシュがある場合に到達する。）
  if (cache.rate != null) {
    logger.warn('All exchange rate APIs failed, serving stale cached rate');
    appendAuditLog('exchange_rate_stale_cache', { rate: cache.rate, ageMs: Date.now() - cache.timestamp });
    try { await notifyExternalAlert('exchange_rate_stale_cache', { rate: cache.rate }); } catch {}
    endTimer();
    return _formatReturn(cache.rate, cache.timestamp, true, withTimestamp);
  }

  logger.warn('All exchange rate APIs failed and no cache; using default rate');
  appendAuditLog('exchange_rate_fallback', { fallback: DEFAULT_RATE });
  try { await notifyExternalAlert('exchange_rate_fallback', { fallback: DEFAULT_RATE }); } catch {}
  endTimer();
  // 本番環境ではキャッシュも実レートも存在しない状態で DEFAULT_RATE（固定値）を
  // 使って注文を作成すると、実市場レートと最大30%以上乖離した価格で決済されてしまう。
  // プロバイダ/借り手のどちらかが必ず損をするため、失敗として伝播させ 503 を返す方が安全。
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Exchange rate unavailable: all providers failed and no cache exists');
  }
  return _formatReturn(DEFAULT_RATE, Date.now(), false, withTimestamp);
}

module.exports = { getBTCtoJPYRate, DEFAULT_RATE };
// テスト用フック: キャッシュ状態を直接操作/検査してSWR挙動を検証する。
module.exports._setCacheForTest = (rate, timestamp) => { cache.rate = rate; cache.timestamp = timestamp; };
module.exports._getCacheForTest = () => ({ ...cache });
module.exports._resetCacheForTest = () => { cache.rate = null; cache.timestamp = 0; _refreshInFlight = null; };
module.exports.CACHE_MS = CACHE_MS;
