// src/api/routes/gpu/reads.js - GPU カタログ読み取り系エンドポイント
// （一覧・単体・レビュー・相場・履歴・見積・適格性・スケジュール）。
const express = require('express');
const router = express.Router();

const { asyncHandler } = require('../../../utils/error-handler');
const { logger } = require('../../../utils/logger');
const { authenticateJWT } = require('../../middleware/security');
const { vgpuManager } = require('../../../core/services');
const GpuRepository = require('../../../db/json/GpuRepository');
const OrderRepository = require('../../../db/json/OrderRepository');
const providerUptime = require('../../../reputation/provider-uptime');
const { fetchRateInfo, computeOrderPricing } = require('../../../utils/order-pricing');
const { computeRenterRating, evaluateRenterEligibility } = require('../../../services/renter-eligibility');

// Short-lived cache for per-GPU rating aggregation (O(n) order scan).
// TTL: 3 minutes — stale long enough to cut DoS load, fresh enough for display.
// Invalidated when a review is submitted (see order routes).
const _gpuRatingCache = new Map();
const GPU_RATING_TTL = process.env.NODE_ENV === 'test' ? 0 : 3 * 60 * 1000;

function getGpuRating(gpuId) {
  const cached = _gpuRatingCache.get(gpuId);
  if (cached && Date.now() - cached.cachedAt < GPU_RATING_TTL) return cached;
  const orders = OrderRepository.getAll().filter(o => o.gpuId === gpuId && o.review);
  const count = orders.length;
  const avg = count > 0
    ? Math.round((orders.reduce((s, o) => s + o.review.rating, 0) / count) * 10) / 10
    : null;
  const entry = { avg, count, cachedAt: Date.now() };
  _gpuRatingCache.set(gpuId, entry);
  return entry;
}

function invalidateGpuRatingCache(gpuId) {
  _gpuRatingCache.delete(gpuId);
}

router._invalidateGpuRatingCache = invalidateGpuRatingCache;

router.get('/', asyncHandler(async (req, res) => {
  logger.info('Fetching available GPUs');
  // クエリパラメータからフィルタリング条件を取得
  let parsedFeatures = null;
  if (req.query.features) {
    // HPP（HTTP Parameter Pollution）対策: 同一パラメータが複数回送られると Express は
    // 配列にする（例: ?features=A&features=B → req.query.features = ['A','B']）。
    // 配列に対する .length は要素数であり文字数でないため、512 バイト上限チェックを
    // すり抜けてしまう。文字列型以外は早期拒否する。
    if (typeof req.query.features !== 'string') {
      return res.status(400).json({ error: '"features" query param must be provided once' });
    }
    // サイズ制限: 未認証呼び出し元が巨大な JSON を送り O(keys × GPUs) の CPU DoS を起こせる。
    // 512 バイト超 or 20 キー超は拒否する。
    if (req.query.features.length > 512) {
      return res.status(400).json({ error: '"features" query param exceeds 512 character limit' });
    }
    try {
      parsedFeatures = JSON.parse(req.query.features);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid "features" query: must be valid JSON' });
    }
    if (parsedFeatures !== null && typeof parsedFeatures === 'object' && !Array.isArray(parsedFeatures)) {
      if (Object.keys(parsedFeatures).length > 20) {
        return res.status(400).json({ error: '"features" may not contain more than 20 keys' });
      }
    } else if (parsedFeatures !== null) {
      return res.status(400).json({ error: '"features" must be a JSON object' });
    }
  }
  // minMemoryGB: 整数 0–8192 GB。負値はフィルタが `> 0` チェックで無視され、
  // 全 GPU を返してしまうバイパスになる。上限も GPU の最大 VRAM を超える値は無意味。
  let _minMemGB = 0;
  if (req.query.minMemoryGB !== undefined) {
    _minMemGB = parseInt(req.query.minMemoryGB, 10);
    if (!Number.isInteger(_minMemGB) || isNaN(_minMemGB) || _minMemGB < 0 || _minMemGB > 8192) {
      return res.status(400).json({ error: 'minMemoryGB must be an integer between 0 and 8192' });
    }
  }
  // maxPrice: 正の有限数のみ許可。0 や負値は意味がない（全 GPU が除外される）。
  let _maxPrice = null;
  if (req.query.maxPrice !== undefined) {
    _maxPrice = parseFloat(req.query.maxPrice);
    if (!Number.isFinite(_maxPrice) || _maxPrice <= 0) {
      return res.status(400).json({ error: 'maxPrice must be a positive number' });
    }
  }
  const filters = {
    minMemoryGB: _minMemGB,
    vendor: req.query.vendor ? String(req.query.vendor).slice(0, 64) : null,
    maxPrice: _maxPrice,
    features: parsedFeatures,
    country: req.query.country ? String(req.query.country).slice(0, 4).toUpperCase() : null,
    apiType: req.query.apiType ? String(req.query.apiType).slice(0, 16) : null,
    search: req.query.search ? String(req.query.search).slice(0, 128).toLowerCase() : null,
  };
  // ファイル永続化されたGPUリストを取得
  let gpus = GpuRepository.getAll();
  // フィルタリング
  if (filters.minMemoryGB > 0) {
    gpus = gpus.filter(gpu => gpu.memoryGB >= filters.minMemoryGB);
  }
  if (filters.vendor) {
    gpus = gpus.filter(gpu => gpu.vendor.toLowerCase().includes(filters.vendor.toLowerCase()));
  }
  if (filters.maxPrice) {
    gpus = gpus.filter(gpu => gpu.pricePerHour <= filters.maxPrice);
  }
  if (filters.features) {
    gpus = gpus.filter(gpu => {
      if (!gpu.features) return false;
      // 要求された機能がすべて含まれているか確認
      for (const [feature, required] of Object.entries(filters.features)) {
        if (required && !gpu.features[feature]) {
          return false;
        }
      }
      return true;
    });
  }
  if (filters.country) {
    gpus = gpus.filter(gpu => gpu.location && gpu.location.country &&
      gpu.location.country.toUpperCase() === filters.country);
  }
  if (filters.apiType) {
    const api = filters.apiType.toUpperCase();
    gpus = gpus.filter(gpu => gpu.apiType && gpu.apiType.toUpperCase() === api);
  }
  if (filters.search) {
    const q = filters.search;
    gpus = gpus.filter(gpu =>
      (gpu.name && gpu.name.toLowerCase().includes(q)) ||
      (gpu.model && gpu.model.toLowerCase().includes(q)) ||
      (gpu.vendor && gpu.vendor.toLowerCase().includes(q))
    );
  }
  // 占有状況の注釈: 現時刻と時間帯が重複する BLOCKING 注文がある GPU は available=false。
  // 二重予約は注文作成時に 409 で拒否されるため、ここは閲覧時のヒント表示。
  // Single getAll() — derive both occupancy and ratings from one read to halve disk I/O.
  const BLOCKING = new Set(['pending', 'matched', 'active']);
  const nowMs = Date.now();
  const allOrders = OrderRepository.getAll();
  const occupiedGpuIds = new Set(
    allOrders.filter(o => {
      if (!BLOCKING.has(o.status)) return false;
      const slotStart = new Date(o.scheduledStartAt || o.createdAt).getTime();
      const slotEnd = slotStart + (o.durationMinutes || 0) * 60 * 1000;
      return slotStart <= nowMs && slotEnd > nowMs;
    }).map(o => o.gpuId)
  );
  // available: プロバイダが手動で false に設定している場合はそれを優先し、
  // そうでなければ現在時刻に手動ブロック or 重複注文がない場合は true とする。
  gpus = gpus.map(gpu => {
    if (gpu.available === false) return { ...gpu, available: false };
    const manuallyBlocked = Array.isArray(gpu.manualBlocks) && gpu.manualBlocks.some(b => {
      const bs = new Date(b.from).getTime();
      const be = new Date(b.to).getTime();
      return bs <= nowMs && be > nowMs;
    });
    return { ...gpu, available: !manuallyBlocked && !occupiedGpuIds.has(gpu.id) };
  });
  // ?available=true で空き GPU のみに絞り込み
  if (req.query.available === 'true') {
    gpus = gpus.filter(gpu => gpu.available);
  }
  // ?minRating=N (1–5) で平均評価が N 以上の GPU のみに絞り込み（レビューなし GPU は除外）
  // レーティングは sort=rating でも使うので先に計算しておく
  const reviewMap = new Map(); // gpuId → { sum, count }
  for (const o of allOrders) {
    if (o.review && o.gpuId) {
      const raw = Number(o.review.rating);
      if (!Number.isFinite(raw)) continue;
      const clamped = Math.min(5, Math.max(1, raw));
      const cur = reviewMap.get(o.gpuId) || { sum: 0, count: 0 };
      cur.sum += clamped;
      cur.count++;
      reviewMap.set(o.gpuId, cur);
    }
  }
  // minRating: 1–5 の範囲で検証。負値を渡すと `> 0` のガードをすり抜けてフィルタが
  // スキップされ全 GPU が返ってしまう（minMemoryGB の旧バグと同じパターン）。
  // 範囲外は明示的に 400 を返して曖昧な結果を防ぐ。
  if (req.query.minRating !== undefined) {
    const _minRating = parseFloat(req.query.minRating);
    if (!Number.isFinite(_minRating) || _minRating < 1 || _minRating > 5) {
      return res.status(400).json({ error: 'minRating must be a number between 1 and 5' });
    }
    gpus = gpus.filter(gpu => {
      const r = reviewMap.get(gpu.id);
      if (!r || r.count === 0) return false;
      return (r.sum / r.count) >= _minRating;
    });
  }
  // ソート: ?sort=price(default)|rating(高→低)|memory(高→低)|reliability(高→低)|availability(空き優先)
  // ?sortDir=asc(default)|desc で方向を逆転（price/memory のみ有効; rating/reliability は常に高→低）
  const sort = req.query.sort || 'price';
  const sortDir = req.query.sortDir === 'desc' ? -1 : 1;
  // 信頼性は providerId 単位でファイル読み取りを伴うため、リクエスト内でメモ化する
  // （ソート比較で同一 provider を何度も引くのと、レスポンス整形での再取得を防ぐ）。
  const _relCache = new Map();
  const relFor = (pid) => {
    if (!pid) return { score: null, tier: 'unrated', sessions: 0, beats: 0, gapEvents: 0, measuring: false };
    if (!_relCache.has(pid)) _relCache.set(pid, providerUptime.getReliability(pid));
    return _relCache.get(pid);
  };
  if (sort === 'rating') {
    gpus.sort((a, b) => {
      const ra = reviewMap.get(a.id);
      const rb = reviewMap.get(b.id);
      const avgA = ra && ra.count > 0 ? ra.sum / ra.count : 0;
      const avgB = rb && rb.count > 0 ? rb.sum / rb.count : 0;
      return avgB - avgA; // 常に高評価順（降順）
    });
  } else if (sort === 'memory') {
    gpus.sort((a, b) => sortDir * (b.memoryGB - a.memoryGB));
  } else if (sort === 'reliability') {
    // 信頼性スコアの高い順（未計測=null は 0 扱いで末尾に寄せる）。常に降順。
    gpus.sort((a, b) => {
      const sa = relFor(a.providerId).score || 0;
      const sb = relFor(b.providerId).score || 0;
      return sb - sa;
    });
  } else if (sort === 'availability') {
    // 空き GPU を先に表示
    gpus.sort((a, b) => {
      if (a.available === b.available) return a.pricePerHour - b.pricePerHour;
      return a.available ? -1 : 1;
    });
  } else {
    // price (default)
    gpus.sort((a, b) => sortDir * (a.pricePerHour - b.pricePerHour));
  }
  // ページネーション（limit: 1..200 既定50 / offset: 0..100000）
  // offset を上限化する理由: 未認証エンドポイントで offset=999999999 を指定されると
  // gpus 配列全体をロードした後 O(n) slice が走りイベントループをブロックする DoS になる。
  const totalCount = gpus.length;
  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.min(offsetRaw, 100000) : 0;
  const pagedGpus = gpus.slice(offset, offset + limit);

  // 全 GPU の状況サマリ（ページング前の全体集計）
  const allGpus = GpuRepository.getAll();
  const totalRegistered = allGpus.length;
  const totalAvailable = allGpus.filter(g => g.available !== false && !occupiedGpuIds.has(g.id)).length;
  const totalOccupied = allGpus.filter(g => occupiedGpuIds.has(g.id)).length;

  // レスポンスに追加情報を含める（reviewMap を使ってページ内 GPU に rating を付与）
  const response = {
    message: 'Fetched available GPUs',
    total: totalCount,
    limit,
    offset,
    summary: { totalRegistered, totalAvailable, totalOccupied },
    gpus: pagedGpus.map(({ apiKey, providerId: _pid, manualBlocks: _mb, ...gpu }) => {
      const r = reviewMap.get(gpu.id);
      const rel = relFor(_pid);
      return {
        ...gpu,
        rating: r && r.count > 0
          ? { average: Math.round((r.sum / r.count) * 10) / 10, count: r.count }
          : { average: null, count: 0 },
        // 客観的な信頼性シグナル（プロバイダー身元は露出しない — 集計値のみ）
        reliability: { score: rel.score, tier: rel.tier, sessions: rel.sessions },
      };
    }),
    timestamp: new Date().toISOString()
  };
  res.json(response);
}));

// プロバイダ自身のGPU一覧（認証必須 — ページネーションと available フラグを含む）
// GET /gpus/my

router.get('/my', authenticateJWT, asyncHandler(async (req, res) => {
  const providerId = req.user.id;
  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.min(offsetRaw, 100000) : 0;

  let gpus = GpuRepository.getAll().filter(g => g.providerId === providerId);
  const total = gpus.length;
  // apiKey はプロバイダ自身のレスポンスにも含めない（他タブ・XSS・ログ経由での漏洩防止）
  const page = gpus.slice(offset, offset + limit).map(({ apiKey, ...g }) => g);
  res.json({ total, limit, offset, gpus: page });
}));

// 特定のGPUの詳細情報を取得（レーティング集計を含む）

router.get('/:id', asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  logger.info(`Fetching GPU detail: ${gpuId}`);
  // ファイル永続化GPUリポジトリから取得
  let gpu = GpuRepository.getById(gpuId);
  if (!gpu) {
    return res.status(404).json({ error: 'GPU not found' });
  }
  // 詳細情報取得（vgpuManager 未導入時は null）。
  // details/usageStats はオーナー/管理者にのみ返す — 借り手の稼働パターン de-anonymize を防ぐ。
  // /gpus/* は GET 公開のため req.user が無いケース（未認証マーケット閲覧）で必ず安全側に倒す。
  const viewerIsOwnerOrAdmin = req.user && (req.user.role === 'admin' || gpu.providerId === req.user.id);
  const details = (vgpuManager && viewerIsOwnerOrAdmin) ? await vgpuManager.getGPUDetails(gpuId).catch(() => null) : null;
  const usageStats = (vgpuManager && viewerIsOwnerOrAdmin) ? await vgpuManager.getGPUUsageStats(gpuId).catch(() => null) : null;
  const availability = vgpuManager ? await vgpuManager.getGPUAvailability(gpuId).catch(() => null) : null;
  // レーティング集計（TTL キャッシュ付き — 生 O(n) スキャンの繰り返し呼び出しを防ぐ）
  const { avg: ratingAverage, count: ratingCount } = getGpuRating(gpuId);
  // レスポンスを構築。
  // providerId: 公開エンドポイントで返すとプロバイダ身元列挙に使われる（リスト側と同じ扱い）。
  //   オーナー/管理者には返す（本人は自分の ID を知る必要がある）。
  // manualBlocks: 予約空き状況の内部スケジュールデータ — 公開しない（リスト側と同じ扱い）。
  // apiKey: 常に除外。
  const { apiKey, providerId, manualBlocks, ...gpuSafe } = gpu;
  const rel = providerUptime.getReliability(providerId);
  const response = {
    message: 'Fetched GPU detail',
    gpu: {
      ...gpuSafe,
      ...(viewerIsOwnerOrAdmin ? { providerId, manualBlocks } : {}),
      details, usageStats, availability,
      rating: { average: ratingAverage, count: ratingCount },
      // 客観的な信頼性シグナル（集計値のみ — プロバイダー身元は露出しない）
      reliability: { score: rel.score, tier: rel.tier, sessions: rel.sessions, beats: rel.beats, gapEvents: rel.gapEvents, measuring: rel.measuring },
    }
  };
  res.json(response);
}));

// GPU レビュー一覧（認証不要 — マーケットプレイスブラウジングと同等）

router.get('/:id/reviews', asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  const gpu = GpuRepository.getById(gpuId);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });

  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  // レビュー本体を spread すると reviewerId（借り手の UUID）が漏れ、認証済み任意ユーザーが
   // GPU 単位で借り手を列挙できる（renter の注文列挙に利用可能）。
   // 公開して問題ない rating/comment/reviewedAt のみを明示的に投影する。
  const reviews = OrderRepository.getAll()
    .filter(o => o.gpuId === gpuId && o.review)
    .sort((a, b) => (b.review.reviewedAt || '').localeCompare(a.review.reviewedAt || ''))
    .map(o => ({
      orderId: o.id,
      rating: o.review.rating,
      comment: o.review.comment,
      reviewedAt: o.review.reviewedAt,
    }));

  const total = reviews.length;
  const page = reviews.slice(offset, offset + limit);
  const ratingAverage = total > 0
    ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / total) * 10) / 10
    : null;

  res.json({ gpuId, total, limit, offset, ratingAverage, reviews: page });
}));

// 同機種の相場（中央値・最小・最大 sats/時）取得（認証不要 — マーケット閲覧と同等）。
// 借り手が「この価格は妥当か」を他機種横断ではなく同一 model 内で判断できるようにする。
// price-watch (値下げ通知) の自然な発展形 — 既存の listings データのみで算出し、
// 新しい永続化は不要。

router.get('/:id/market-rate', asyncHandler(async (req, res) => {
  const gpu = GpuRepository.getById(req.params.id);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });

  const peers = GpuRepository.getAll()
    .filter(g => g.model === gpu.model && typeof g.pricePerHour === 'number' && g.pricePerHour > 0)
    .map(g => g.pricePerHour)
    .sort((a, b) => a - b);
  const sampleCount = peers.length;
  const mid = Math.floor(sampleCount / 2);
  const medianPricePerHour = sampleCount === 0
    ? null
    : sampleCount % 2 === 1
      ? peers[mid]
      : Math.round((peers[mid - 1] + peers[mid]) / 2);

  res.json({
    gpuId: gpu.id,
    model: gpu.model,
    sampleCount,
    medianPricePerHour,
    minPricePerHour: sampleCount > 0 ? peers[0] : null,
    maxPricePerHour: sampleCount > 0 ? peers[sampleCount - 1] : null,
  });
}));

// GPU注文履歴取得（認証必須 — 所有者または管理者のみ）
// プロバイダが自分のGPUの使用状況を把握するためのエンドポイント。
// ?limit=N ?offset=N ?status=completed|cancelled|etc. でフィルタリング可能。

router.get('/:id/history', authenticateJWT, asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  const gpu = GpuRepository.getById(gpuId);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });
  if (req.user.role !== 'admin' && gpu.providerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const statusFilter = req.query.status || null;

  let orders = OrderRepository.getAll().filter(o => o.gpuId === gpuId);
  if (statusFilter) orders = orders.filter(o => o.status === statusFilter);
  orders = orders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const total = orders.length;
  // 借り手 userId を生で返すと、安価な GPU を撒餌に出品して借り手 UUID を量産収集する
  // 大量列挙攻撃が成立する（renter の注文列挙に利用可能）。
  // プロバイダは自分の GPU の稼働実績（料金・期間・レビュー有無）だけ知れれば十分なので
  // 借り手の内部 ID は返さない。
  const page = orders.slice(offset, offset + limit).map(o => ({
    orderId: o.id,
    status: o.status,
    durationMinutes: o.durationMinutes,
    totalPrice: o.totalPrice || null,
    createdAt: o.createdAt,
    startedAt: o.startedAt || null,
    stoppedAt: o.stoppedAt || null,
    cancelledAt: o.cancelledAt || null,
    hasReview: !!o.review,
    reviewRating: o.review ? o.review.rating : null,
  }));

  res.json({ gpuId, total, limit, offset, orders: page });
}));

// GPU出品登録 (認証必須)

router.get('/:id/estimate', asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  const gpu = GpuRepository.getById(gpuId);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });
  if (!gpu.pricePerHour || gpu.pricePerHour <= 0) {
    return res.status(400).json({ error: 'GPU does not have a valid price configured' });
  }
  const durationRaw = parseInt(req.query.durationMinutes, 10);
  if (!Number.isInteger(durationRaw) || durationRaw <= 0 || durationRaw % 5 !== 0 || durationRaw > 43200) {
    return res.status(400).json({ error: 'durationMinutes must be a positive integer, a multiple of 5, and at most 43200 (30 days)' });
  }
  const rateInfo = await fetchRateInfo();
  const pricing = computeOrderPricing({ gpuId, durationMinutes: durationRaw, pricePerHour: gpu.pricePerHour }, rateInfo);

  // 空き状況チェック（見積もり時点の参考情報 — 確定は注文作成時に行う）
  const BLOCKING = new Set(['pending', 'matched', 'active']);
  let scheduledStart = Date.now();
  if (req.query.scheduledStartAt) {
    scheduledStart = Date.parse(req.query.scheduledStartAt);
    if (!Number.isFinite(scheduledStart)) return res.status(400).json({ error: 'Invalid scheduledStartAt date' });
  }
  const scheduledEnd = scheduledStart + durationRaw * 60 * 1000;
  const conflicting = OrderRepository.getAll().find(o => {
    if (o.gpuId !== gpuId || !BLOCKING.has(o.status)) return false;
    const s = new Date(o.scheduledStartAt || o.createdAt).getTime();
    const e = s + (o.durationMinutes || 0) * 60 * 1000;
    return scheduledStart < e && scheduledEnd > s;
  });

  res.json({
    gpuId,
    gpuName: gpu.name,
    durationMinutes: durationRaw,
    ...pricing,
    exchangeRateTimestamp: rateInfo.timestamp,
    availableAtRequestedTime: !conflicting,
    minRenterRating: gpu.minRenterRating || null,
  });
}));

// 借り手資格事前チェック（認証必須）
// GET /gpus/:id/eligibility
// 現在のユーザーがこの GPU を注文できる資格を持つか事前に確認できる。
// rejectUnratedRenters / minRenterRating に引っかかる借り手は注文作成前に
// この API で理由を確認し、不要な 422 を避けられる。

router.get('/:id/eligibility', authenticateJWT, asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  const gpu = GpuRepository.getById(gpuId);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });

  // 資格判定は renter-eligibility に集約（POST /orders と同一ロジックを共有）。
  const renterRating = computeRenterRating(OrderRepository.getAll(), req.user.id);
  const verdict = evaluateRenterEligibility(gpu, req.user.id, renterRating);

  return res.json({
    eligible: verdict.eligible,
    reason: verdict.reason,
    message: verdict.message,
    requirements: {
      minRenterRating: gpu.minRenterRating || null,
      rejectUnratedRenters: gpu.rejectUnratedRenters === true,
    },
    renterRating: gpu.providerId === req.user.id ? null : renterRating,
  });
}));

// GPU 手動ブロック登録（メンテナンス・個人利用等）
// POST /gpus/:id/block — 認証必須（GPU オーナーまたは管理者）

router.get('/:id/schedule', asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  const gpu = GpuRepository.getById(gpuId);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });

  const nowMs = Date.now();
  const defaultTo = new Date(nowMs + 7 * 24 * 60 * 60 * 1000);

  const from = req.query.from ? new Date(req.query.from) : new Date(nowMs);
  const to = req.query.to ? new Date(req.query.to) : defaultTo;

  if (isNaN(from.getTime())) return res.status(400).json({ error: 'Invalid "from" date' });
  if (isNaN(to.getTime())) return res.status(400).json({ error: 'Invalid "to" date' });
  if (from >= to) return res.status(400).json({ error: '"from" must be before "to"' });
  // 最大照会ウィンドウ: 180日。過度に広いウィンドウは大量スロットを返すレスポンス DoS になる。
  const MAX_SCHEDULE_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
  if (to - from > MAX_SCHEDULE_WINDOW_MS) {
    return res.status(400).json({ error: 'Schedule query window cannot exceed 180 days' });
  }

  const BLOCKING = new Set(['pending', 'matched', 'active']);

  const blockedSlots = OrderRepository.getAll()
    .filter(o => o.gpuId === gpuId && BLOCKING.has(o.status))
    .map(o => {
      const slotStart = new Date(o.scheduledStartAt || o.createdAt);
      const slotEnd = new Date(slotStart.getTime() + (o.durationMinutes || 0) * 60 * 1000);
      // orderId・status は非公開: orderId は注文 ID 列挙防止、status は
      // active/matched/pending を返すと稼働状況の競合情報調査に使われる
      // （認証不要エンドポイントのため競合他社によるプロバイダ稼働モニタリングが成立する）。
      // スロットの占有期間のみで予約重複チェックには十分。
      return { from: slotStart.toISOString(), to: slotEnd.toISOString(), type: 'order' };
    })
    .filter(slot => new Date(slot.from) < to && new Date(slot.to) > from)
    .sort((a, b) => a.from.localeCompare(b.from));

  // reason フィールドは非公開: プロバイダの業務上のメモが漏洩しないよう除去する。
  const manualBlocks = (Array.isArray(gpu.manualBlocks) ? gpu.manualBlocks : [])
    .filter(b => new Date(b.from) < to && new Date(b.to) > from)
    .map(({ reason: _r, ...b }) => ({ ...b, type: 'manual' }))
    .sort((a, b) => a.from.localeCompare(b.from));

  res.json({
    gpuId,
    from: from.toISOString(),
    to: to.toISOString(),
    blockedSlots,
    manualBlocks,
  });
}));

// GPU 価格ウォッチ登録（値下げアラート）
// POST /gpus/:id/watch — 認証必須（自分が提供していないGPUのみ登録可）

module.exports = router;
