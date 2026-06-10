// src/api/middleware/cache.js - LRUキャッシュミドルウェア
// lru-cache v10 では名前付きエクスポート(LRUCache)を使用する
const { LRUCache } = require('lru-cache');
const { logger } = require('../../utils/logger');
const { appendAuditLog } = require('../../utils/audit-log');
const client = require('prom-client');

// Prometheusメトリクス
const cacheHitCounter = new client.Counter({ name: 'api_cache_hit_total', help: 'Total API cache hits' });
const cacheMissCounter = new client.Counter({ name: 'api_cache_miss_total', help: 'Total API cache misses' });
const cachePurgeCounter = new client.Counter({ name: 'api_cache_purge_total', help: 'Total API cache purges' });

// キャッシュ容量・TTLは要件に応じて調整
const cache = new LRUCache({
  max: 1000,
  ttl: 60 * 1000 // 60秒
});

// キャッシュミドルウェア生成
// perUser: true の場合、キャッシュキーにユーザーIDを含める。
// ユーザー毎に内容が異なるレスポンス（注文一覧等）を URL のみでキャッシュすると
// 他ユーザーのデータが返る（認可バイパス）ため、per-user データでは必須。
function cacheMiddleware(options = {}) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const key = options.perUser
      ? `${(req.user && req.user.id) || 'anon'}:${req.originalUrl}`
      : req.originalUrl;
    const cached = cache.get(key);
    if (cached) {
      logger.info(`Cache hit: ${key}`);
      appendAuditLog('api_cache_hit', { url: key });
      cacheHitCounter.inc();
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }
    // レスポンスキャプチャ
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      cache.set(key, body);
      logger.info(`Cache set: ${key}`);
      appendAuditLog('api_cache_set', { url: key });
      cacheMissCounter.inc();
      res.set('X-Cache', 'MISS');
      return originalJson(body);
    };
    next();
  };
}

// キャッシュ全体パージ関数（管理API等で利用可）
function purgeCache() {
  cache.clear();
  cachePurgeCounter.inc();
  logger.info('Cache purged');
  appendAuditLog('api_cache_purge', {});
}

module.exports = { cacheMiddleware, cache, purgeCache, cacheHitCounter, cacheMissCounter, cachePurgeCounter };

