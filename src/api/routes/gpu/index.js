// src/api/routes/gpu/index.js - GPU関連APIルート
const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas, Joi } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole, allowOwnerOrAdmin } = require('../../middleware/security');

// コアサービスは共有のガード付きシングルトンから取得（未導入時は null）
const { gpuDetector, vgpuManager, p2pNetwork, requireService } = require('../../../core/services');
// ファイルベースJSONストレージリポジトリ
const GpuRepository = require('../../../db/json/GpuRepository');
// GPU アテステーション（申告スペック vs デバイス計測の照合）
const { createMockAttestationVerifier } = require('../../../security/gpu-attestation-verifier');
// 開発/テスト時は Mock、本番では実 nvtrust アダプタへ置き換え可能（DI）
const _attestationVerifier = createMockAttestationVerifier();
// プロバイダ・レピュテーション記録（アテステーション結果の反映）
const { createReputationService } = require('../../../reputation/reputation-service');
const { sanitizeObject } = require('../../../utils/sanitize');

// Short-lived cache for per-GPU rating aggregation (O(n) order scan).
// TTL: 3 minutes — stale long enough to cut DoS load, fresh enough for display.
// Invalidated when a review is submitted (see order routes).
const _gpuRatingCache = new Map();
const GPU_RATING_TTL = process.env.NODE_ENV === 'test' ? 0 : 3 * 60 * 1000;

function getGpuRating(gpuId) {
  const cached = _gpuRatingCache.get(gpuId);
  if (cached && Date.now() - cached.cachedAt < GPU_RATING_TTL) return cached;
  const OrderRepository = require('../../../db/json/OrderRepository');
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

module.exports._invalidateGpuRatingCache = invalidateGpuRatingCache;

// 利用可能なGPU一覧を取得
router.get('/', asyncHandler(async (req, res) => {
  logger.info('Fetching available GPUs');
  // クエリパラメータからフィルタリング条件を取得
  let parsedFeatures = null;
  if (req.query.features) {
    try {
      parsedFeatures = JSON.parse(req.query.features);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid "features" query: must be valid JSON' });
    }
  }
  if (req.query.minMemoryGB && isNaN(parseInt(req.query.minMemoryGB, 10))) {
    return res.status(400).json({ error: 'minMemoryGB must be a number' });
  }
  if (req.query.maxPrice && isNaN(parseFloat(req.query.maxPrice))) {
    return res.status(400).json({ error: 'maxPrice must be a number' });
  }
  const filters = {
    minMemoryGB: req.query.minMemoryGB ? parseInt(req.query.minMemoryGB, 10) : 0,
    vendor: req.query.vendor ? String(req.query.vendor).slice(0, 64) : null,
    maxPrice: req.query.maxPrice ? parseFloat(req.query.maxPrice) : null,
    features: parsedFeatures,
    country: req.query.country ? String(req.query.country).slice(0, 4).toUpperCase() : null,
    apiType: req.query.apiType ? String(req.query.apiType).slice(0, 16) : null,
    search: req.query.search ? String(req.query.search).slice(0, 128).toLowerCase() : null,
  };
  // ファイル永続化されたGPUリストを取得
  let gpus = GpuRepository.getAll();
  // P2Pネットワークから提供されているGPUも取得（P2P無効時はスキップ）
  if (p2pNetwork && typeof p2pNetwork.getAvailableGPUs === 'function') {
    try {
      const p2pGpus = await p2pNetwork.getAvailableGPUs();
      if (Array.isArray(p2pGpus)) gpus = [...gpus, ...p2pGpus];
    } catch (e) {
      logger.warn(`P2P GPU fetch failed, returning local GPUs only: ${e.message}`);
    }
  }
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
  const OrderRepository = require('../../../db/json/OrderRepository');
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
      const cur = reviewMap.get(o.gpuId) || { sum: 0, count: 0 };
      cur.sum += o.review.rating;
      cur.count++;
      reviewMap.set(o.gpuId, cur);
    }
  }
  const minRatingRaw = parseFloat(req.query.minRating);
  if (!isNaN(minRatingRaw) && minRatingRaw > 0) {
    gpus = gpus.filter(gpu => {
      const r = reviewMap.get(gpu.id);
      if (!r || r.count === 0) return false;
      return (r.sum / r.count) >= minRatingRaw;
    });
  }
  // ソート: ?sort=price(default)|rating(高→低)|memory(高→低)|availability(空き優先)
  // ?sortDir=asc(default)|desc で方向を逆転（price/memory のみ有効; rating は常に高→低）
  const sort = req.query.sort || 'price';
  const sortDir = req.query.sortDir === 'desc' ? -1 : 1;
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
  // ページネーション（limit: 1..200 既定50 / offset: 0..）
  const totalCount = gpus.length;
  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
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
    gpus: pagedGpus.map(({ apiKey, ...gpu }) => {
      const r = reviewMap.get(gpu.id);
      return {
        ...gpu,
        rating: r && r.count > 0
          ? { average: Math.round((r.sum / r.count) * 10) / 10, count: r.count }
          : { average: null, count: 0 },
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
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  let gpus = GpuRepository.getAll().filter(g => g.providerId === providerId);
  const total = gpus.length;
  const page = gpus.slice(offset, offset + limit);
  res.json({ total, limit, offset, gpus: page });
}));

// 特定のGPUの詳細情報を取得（レーティング集計を含む）
router.get('/:id', asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  logger.info(`Fetching GPU detail: ${gpuId}`);
  // ファイル永続化GPUリポジトリから取得
  let gpu = GpuRepository.getById(gpuId);
  if (!gpu && p2pNetwork && typeof p2pNetwork.getGPUById === 'function') {
    // P2Pネットワークからも検索（P2P無効時はスキップ）
    try { gpu = await p2pNetwork.getGPUById(gpuId); } catch (_) {}
  }
  if (!gpu) {
    return res.status(404).json({ error: 'GPU not found' });
  }
  // 詳細情報取得（vgpuManager 未導入時は null）
  const details = vgpuManager ? await vgpuManager.getGPUDetails(gpuId).catch(() => null) : null;
  const usageStats = vgpuManager ? await vgpuManager.getGPUUsageStats(gpuId).catch(() => null) : null;
  const availability = vgpuManager ? await vgpuManager.getGPUAvailability(gpuId).catch(() => null) : null;
  // レーティング集計（TTL キャッシュ付き — 生 O(n) スキャンの繰り返し呼び出しを防ぐ）
  const { avg: ratingAverage, count: ratingCount } = getGpuRating(gpuId);
  // レスポンスを構築（apiKey等除外）
  const { apiKey, ...gpuSafe } = gpu;
  const response = {
    message: 'Fetched GPU detail',
    gpu: { ...gpuSafe, details, usageStats, availability, rating: { average: ratingAverage, count: ratingCount } }
  };
  res.json(response);
}));

// GPU レビュー一覧（認証不要 — マーケットプレイスブラウジングと同等）
router.get('/:id/reviews', asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  const gpu = GpuRepository.getById(gpuId);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });

  const OrderRepository = require('../../../db/json/OrderRepository');
  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const reviews = OrderRepository.getAll()
    .filter(o => o.gpuId === gpuId && o.review)
    .sort((a, b) => (b.review.reviewedAt || '').localeCompare(a.review.reviewedAt || ''))
    .map(o => ({ orderId: o.id, ...o.review }));

  const total = reviews.length;
  const page = reviews.slice(offset, offset + limit);
  const ratingAverage = total > 0
    ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / total) * 10) / 10
    : null;

  res.json({ gpuId, total, limit, offset, ratingAverage, reviews: page });
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

  const OrderRepository = require('../../../db/json/OrderRepository');
  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const statusFilter = req.query.status || null;

  let orders = OrderRepository.getAll().filter(o => o.gpuId === gpuId);
  if (statusFilter) orders = orders.filter(o => o.status === statusFilter);
  orders = orders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const total = orders.length;
  const page = orders.slice(offset, offset + limit).map(o => ({
    orderId: o.id,
    userId: o.userId,
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
router.post('/',
  authenticateJWT,
  checkRole(['provider', 'admin']),
  validateMiddleware(schemas.gpu.register),
  asyncHandler(async (req, res) => {
    // 入力値サニタイズ
    // 入力値サニタイズ＋クロスベンダー必須項目
    const gpuInfo = sanitizeObject(req.validatedBody, [
      'name', 'vendor', 'model', 'apiType', 'driverVersion', 'os', 'arch',
      'memoryGB', 'clockMHz', 'powerWatt', 'pricePerHour', 'availability',
      'features', 'capabilities', 'location', 'performance', 'minRenterRating'
    ]);
    logger.info(`[GPU登録] ${gpuInfo.vendor} ${gpuInfo.model} (${gpuInfo.apiType}) by ${req.user.id}`);

    // 提供者ごとのGPU登録数上限チェック（スパム・在庫偽装防止）
    const MAX_GPUS = (() => {
      const raw = process.env.MAX_GPUS_PER_PROVIDER;
      const n = Number(raw);
      return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : 50;
    })();
    if (req.user.role !== 'admin') {
      const providerGpuCount = GpuRepository.getAll().filter(g => g.providerId === req.user.id).length;
      if (providerGpuCount >= MAX_GPUS) {
        return res.status(429).json({ error: `GPU registration limit reached (max ${MAX_GPUS} per provider)` });
      }
    }

    // 重複登録チェック（model, vendor, providerId, memoryGB）
    const duplicate = GpuRepository.getAll().find(g =>
      g.name === gpuInfo.name &&
      g.model === gpuInfo.model &&
      g.vendor === gpuInfo.vendor &&
      g.memoryGB === gpuInfo.memoryGB &&
      g.providerId === req.user.id
    );
    if (duplicate) {
      return res.status(409).json({ error: 'Duplicate GPU spec already registered' });
    }
    // ユーザーIDを設定
    gpuInfo.providerId = req.user.id;
    // クロスベンダー用のcapabilities自動補完
    gpuInfo.capabilities = gpuInfo.capabilities || {};
    if (gpuInfo.apiType === 'CUDA') gpuInfo.capabilities.cuda = true;
    if (gpuInfo.apiType === 'ROCm') gpuInfo.capabilities.rocm = true;
    if (gpuInfo.apiType === 'oneAPI') gpuInfo.capabilities.oneapi = true;
    if (gpuInfo.apiType === 'OpenCL') gpuInfo.capabilities.opencl = true;

    // GPU アテステーション（任意）— リクエストに attestationReport が含まれる場合に検証
    if (req.body.attestationReport) {
      try {
        const attResult = await _attestationVerifier.verify(gpuInfo, req.body.attestationReport);
        gpuInfo.attestation = {
          passed: attResult.passed,
          score: attResult.score,
          findings: attResult.findings,
          verifiedAt: new Date().toISOString(),
        };
        // レピュテーション記録（DI 済みシングルトン）
        const repSvc = createReputationService();
        repSvc.recordAttestation(req.user.id, attResult.passed);
        if (!attResult.passed) {
          logger.warn(`[GPU登録] アテステーション失敗: providerId=${req.user.id} score=${attResult.score} findings=${attResult.findings.join('; ')}`);
        }
      } catch (attErr) {
        logger.warn(`[GPU登録] アテステーション検証エラー（スキップ）: ${attErr.message}`);
        gpuInfo.attestation = { passed: false, score: 0, findings: ['verifier error: ' + attErr.message], verifiedAt: new Date().toISOString() };
      }
    } else {
      gpuInfo.attestation = { passed: false, score: 0, findings: ['no attestation report provided'], verifiedAt: null };
    }

    // P2Pネットワークへアナウンス
    if (p2pNetwork && typeof p2pNetwork.announceGPU === 'function') {
      try { await p2pNetwork.announceGPU(gpuInfo); } catch (_) { /* P2P は optional */ }
    }
    // ファイル永続化リポジトリに登録
    const registeredGpu = GpuRepository.create(gpuInfo);
    // GPUイベントをログに記録
    logger.gpuEvent('gpu_registered', {
      gpuId: registeredGpu.id,
      provider: req.user.id,
      specs: {
        name: registeredGpu.name,
        model: registeredGpu.model,
        vendor: registeredGpu.vendor,
        apiType: registeredGpu.apiType,
        driverVersion: registeredGpu.driverVersion,
        os: registeredGpu.os,
        arch: registeredGpu.arch,
        memoryGB: registeredGpu.memoryGB,
        capabilities: registeredGpu.capabilities
      }
    });
    // apiKey等の機密情報を除外
    const { apiKey, ...gpuSafe } = registeredGpu;
    res.status(201).json({
      message: 'GPU successfully registered',
      gpu: gpuSafe,
      attestation: gpuSafe.attestation || null,
    });
  })
);

// GPU複製（認証必須 — 既存 GPU の仕様をコピーして新しい登録を作成する）
// POST /gpus/:id/clone?name=カスタム名 — id と providerId は新たに生成される
router.post('/:id/clone', authenticateJWT, checkRole(['provider', 'admin']), asyncHandler(async (req, res) => {
  const sourceId = req.params.id;
  const source = GpuRepository.getById(sourceId);
  if (!source) return res.status(404).json({ error: 'GPU not found' });
  if (req.user.role !== 'admin' && source.providerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const {
    id: _id, providerId: _p, createdAt: _c, updatedAt: _u, attestation: _a, manualBlocks: _b,
    apiKey: _ak, ...specFields
  } = source;
  const newName = req.body.name || req.query.name
    ? (req.body.name || req.query.name)
    : `${source.name} (copy)`;
  const cloned = GpuRepository.create({
    ...specFields,
    name: String(newName).slice(0, 128),
    providerId: req.user.id,
    attestation: { passed: false, score: 0, findings: ['cloned from ' + sourceId + '; re-attest to verify'], verifiedAt: null },
  });
  const { apiKey: _k, ...safe } = cloned;
  res.status(201).json({ message: 'GPU cloned successfully', gpu: safe, clonedFrom: sourceId });
}));

// GPU一括登録 (認証必須、最大20台)
// POST /gpus/bulk — 同一プロバイダが複数の GPU をまとめて登録する。
// 各エントリに個別のバリデーションと重複チェックを行い、失敗したものはスキップして
// 結果の配列で返す（部分成功を許容）。
router.post('/bulk',
  authenticateJWT,
  checkRole(['provider', 'admin']),
  asyncHandler(async (req, res) => {
    const entries = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'Request body must be a non-empty array of GPU objects' });
    }
    if (entries.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 GPUs per bulk registration request' });
    }
    // 提供者ごとの上限チェック（単体登録と同じガード — バルクで上限を迂回させない）
    const MAX_GPUS_BULK = (() => {
      const raw = process.env.MAX_GPUS_PER_PROVIDER;
      const n = Number(raw);
      return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : 50;
    })();
    if (req.user.role !== 'admin') {
      const currentCount = GpuRepository.getAll().filter(g => g.providerId === req.user.id).length;
      if (currentCount + entries.length > MAX_GPUS_BULK) {
        return res.status(429).json({
          error: `Would exceed GPU registration limit. Current: ${currentCount}, limit: ${MAX_GPUS_BULK}, requested: ${entries.length}`,
        });
      }
    }
    const { schemas: { gpu: gpuSchemas } } = require('../../../utils/validator');
    const results = [];
    const batchKeys = new Set();
    for (const entry of entries) {
      const { error: valErr, value } = gpuSchemas.register.validate(entry, { abortEarly: false, stripUnknown: true });
      if (valErr) {
        results.push({ success: false, id: entry.id || null, error: valErr.details.map(d => d.message).join('; ') });
        continue;
      }
      const gpuInfo = sanitizeObject(value, [
        'name', 'vendor', 'model', 'apiType', 'driverVersion', 'os', 'arch',
        'memoryGB', 'clockMHz', 'powerWatt', 'pricePerHour', 'availability',
        'features', 'capabilities', 'location', 'performance', 'minRenterRating',
      ]);
      gpuInfo.providerId = req.user.id;
      const dedupKey = `${gpuInfo.name}|${gpuInfo.model}|${gpuInfo.vendor}|${gpuInfo.memoryGB}`;
      if (batchKeys.has(dedupKey)) {
        results.push({ success: false, id: entry.id || null, error: 'Duplicate GPU spec within this batch' });
        continue;
      }
      const duplicate = GpuRepository.getAll().find(g =>
        g.name === gpuInfo.name && g.model === gpuInfo.model &&
        g.vendor === gpuInfo.vendor && g.memoryGB === gpuInfo.memoryGB &&
        g.providerId === req.user.id
      );
      if (duplicate) {
        results.push({ success: false, id: entry.id || null, error: 'Duplicate GPU spec already registered' });
        continue;
      }
      batchKeys.add(dedupKey);
      gpuInfo.capabilities = gpuInfo.capabilities || {};
      if (gpuInfo.apiType === 'CUDA') gpuInfo.capabilities.cuda = true;
      if (gpuInfo.apiType === 'ROCm') gpuInfo.capabilities.rocm = true;
      if (gpuInfo.apiType === 'oneAPI') gpuInfo.capabilities.oneapi = true;
      if (gpuInfo.apiType === 'OpenCL') gpuInfo.capabilities.opencl = true;
      gpuInfo.attestation = { passed: false, score: 0, findings: ['no attestation report provided'], verifiedAt: null };
      const registered = GpuRepository.create(gpuInfo);
      const { apiKey: _k, ...safe } = registered;
      results.push({ success: true, gpu: safe });
    }
    const successCount = results.filter(r => r.success).length;
    res.status(successCount > 0 ? 201 : 400).json({ registered: successCount, total: entries.length, results });
  })
);

// GPU情報更新 (認証必須)
router.put('/:id',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid().required() }).unknown(true), 'params'),
  allowOwnerOrAdmin((req) => GpuRepository.getById(req.params.id)),
  validateMiddleware(schemas.gpu.update),
  asyncHandler(async (req, res) => {
    const gpu = req.resource;
    const gpuId = gpu.id;
    logger.info(`Updating GPU: ${gpuId}`);
    // 入力値サニタイズ
    const sanitized = sanitizeObject(req.body, ['name', 'pricePerHour', 'availability', 'minRenterRating', 'available']);
    // available は boolean のみ許可（任意の型汚染を防ぐ）
    if ('available' in sanitized && typeof sanitized.available !== 'boolean') {
      return res.status(400).json({ error: '"available" must be a boolean' });
    }
    // 名前変更時の重複チェック（memoryGB を正しいフィールド名で参照）
    if (sanitized.name !== undefined && sanitized.name !== gpu.name) {
      const duplicate = GpuRepository.getAll().find(g =>
        g.id !== gpuId &&
        g.name === sanitized.name &&
        g.providerId === gpu.providerId
      );
      if (duplicate) {
        return res.status(409).json({ error: 'Duplicate GPU name already registered by this provider' });
      }
    }
    // GPU情報を更新
    const updatedGPU = GpuRepository.update(gpuId, sanitized);
    logger.info(`GPU updated: ${gpuId}`);
    // apiKey等の機密情報を除外
    const { apiKey, ...gpuSafe } = updatedGPU;
    return res.json({
      message: 'GPU updated successfully',
      gpu: gpuSafe
    });
  })
);

// GPU出品取り下げ (認証必須)
router.delete('/:id', 
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid().required() }).unknown(true), 'params'),
  allowOwnerOrAdmin((req) => GpuRepository.getById(req.params.id)),
  asyncHandler(async (req, res) => {
    const gpuId = req.params.id;
    logger.info(`Removing GPU: ${gpuId}`);

    // アクティブな注文がある場合は削除を拒否（孤立注文を防ぐ）
    const OrderRepository = require('../../../db/json/OrderRepository');
    const BLOCKING = new Set(['pending', 'matched', 'active']);
    const activeOrders = OrderRepository.getAll().filter(o => o.gpuId === gpuId && BLOCKING.has(o.status));
    if (activeOrders.length > 0) {
      return res.status(409).json({
        error: 'Cannot delete GPU with active orders. Cancel or complete all orders first.',
        activeOrderCount: activeOrders.length,
      });
    }

    // GPU登録を削除（ファイル永続化）
    const deleted = GpuRepository.delete(gpuId);
    if (!deleted) {
      return res.status(404).json({ error: 'GPU not found' });
    }
    // P2Pネットワークに削除を通知（P2P無効時はスキップ）
    if (p2pNetwork && typeof p2pNetwork.removeGPU === 'function') {
      try { await p2pNetwork.removeGPU(gpuId); } catch (_) {}
    }
    // GPUイベントをログに記録
    logger.gpuEvent('gpu_removed', {
      gpuId: gpuId,
      provider: req.user.id
    });
    res.json({ message: 'GPU removed successfully', gpuId });
  })
);

// 注文コスト事前見積もり（認証不要、注文作成なし）
// GET /gpus/:id/estimate?durationMinutes=60[&scheduledStartAt=ISO]
// 借り手が実際に注文を作成する前に料金を確認できる。
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
  const { fetchRateInfo, computeOrderPricing } = require('../../../utils/order-pricing');
  const rateInfo = await fetchRateInfo();
  const pricing = computeOrderPricing({ gpuId, durationMinutes: durationRaw, pricePerHour: gpu.pricePerHour }, rateInfo);

  // 空き状況チェック（見積もり時点の参考情報 — 確定は注文作成時に行う）
  const OrderRepository = require('../../../db/json/OrderRepository');
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

// GPU 手動ブロック登録（メンテナンス・個人利用等）
// POST /gpus/:id/block — 認証必須（GPU オーナーまたは管理者）
router.post('/:id/block', authenticateJWT, asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  const gpu = GpuRepository.getById(gpuId);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });
  if (req.user.role !== 'admin' && gpu.providerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { from, to, reason } = req.body;
  if (!from || !to) return res.status(400).json({ error: '"from" and "to" are required' });
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (isNaN(fromMs)) return res.status(400).json({ error: 'Invalid "from" date' });
  if (isNaN(toMs)) return res.status(400).json({ error: 'Invalid "to" date' });
  if (fromMs >= toMs) return res.status(400).json({ error: '"from" must be before "to"' });
  // 最大ブロック期間: 90日。無期限ブロックはプロバイダによる GPU 実質廃棄に相当し、
  // マーケットプレイスのサプライを恒久的に枯渇させる（ゾンビ GPU 問題）。
  const MAX_BLOCK_DURATION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
  if (toMs - fromMs > MAX_BLOCK_DURATION_MS) {
    return res.status(400).json({ error: 'Block duration cannot exceed 90 days' });
  }
  // ブロック数上限: プロバイダが大量のブロックを登録してスキャンを O(n) DoS 化するのを防ぐ。
  const MAX_BLOCKS_PER_GPU = 100;
  const existing = Array.isArray(gpu.manualBlocks) ? gpu.manualBlocks : [];
  if (existing.length >= MAX_BLOCKS_PER_GPU) {
    return res.status(429).json({ error: `Cannot add more than ${MAX_BLOCKS_PER_GPU} manual blocks per GPU. Remove old blocks first.` });
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) {
    return res.status(400).json({ error: '"reason" must be a string (max 200 chars)' });
  }
  const sanitizedReason = reason
    ? reason.replace(/[<>"'&]/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) || null
    : null;

  const { v4: uuidv4 } = require('uuid');
  const block = {
    id: uuidv4(),
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    reason: sanitizedReason,
    createdAt: new Date().toISOString(),
  };
  GpuRepository.update(gpuId, { manualBlocks: [...existing, block] });
  res.status(201).json({ block });
}));

// GPU 手動ブロック削除
// DELETE /gpus/:id/block/:blockId — 認証必須（GPU オーナーまたは管理者）
router.delete('/:id/block/:blockId', authenticateJWT, asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  const gpu = GpuRepository.getById(gpuId);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });
  if (req.user.role !== 'admin' && gpu.providerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const blockId = req.params.blockId;
  const existing = Array.isArray(gpu.manualBlocks) ? gpu.manualBlocks : [];
  const idx = existing.findIndex(b => b.id === blockId);
  if (idx === -1) return res.status(404).json({ error: 'Block not found' });
  const updated = existing.filter(b => b.id !== blockId);
  GpuRepository.update(gpuId, { manualBlocks: updated });
  res.status(200).json({ message: 'Block removed' });
}));

// GPU の予約カレンダー（空き時間帯の照会）
// GET /gpus/:id/schedule?from=ISO&to=ISO
// 認証不要（マーケットプレイスブラウジングと同等）
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

  const OrderRepository = require('../../../db/json/OrderRepository');
  const BLOCKING = new Set(['pending', 'matched', 'active']);

  const blockedSlots = OrderRepository.getAll()
    .filter(o => o.gpuId === gpuId && BLOCKING.has(o.status))
    .map(o => {
      const slotStart = new Date(o.scheduledStartAt || o.createdAt);
      const slotEnd = new Date(slotStart.getTime() + (o.durationMinutes || 0) * 60 * 1000);
      // orderId は非公開: 認証なし閲覧者への注文 ID 列挙を防ぐ。
      // スロットの占有期間と状態のみ返す（予約計画には十分）。
      return { from: slotStart.toISOString(), to: slotEnd.toISOString(), status: o.status, type: 'order' };
    })
    .filter(slot => new Date(slot.from) < to && new Date(slot.to) > from)
    .sort((a, b) => a.from.localeCompare(b.from));

  const manualBlocks = (Array.isArray(gpu.manualBlocks) ? gpu.manualBlocks : [])
    .filter(b => new Date(b.from) < to && new Date(b.to) > from)
    .map(b => ({ ...b, type: 'manual' }))
    .sort((a, b) => a.from.localeCompare(b.from));

  res.json({
    gpuId,
    from: from.toISOString(),
    to: to.toISOString(),
    blockedSlots,
    manualBlocks,
  });
}));

// システムが検出したGPUの一覧を取得 (認証必須)
router.get('/system/detected',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    if (!requireService(gpuDetector, res)) return;
    logger.info('Detecting system GPUs');
    const detectedGPUs = await gpuDetector.detectAllGPUs();
    res.json({
      message: 'System GPUs detected',
      count: detectedGPUs.length,
      gpus: detectedGPUs
    });
  })
);

// AMD GPUの詳細検出 (認証必須)
router.get('/system/amd',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    if (!requireService(gpuDetector, res)) return;
    logger.info('Detecting AMD GPUs with advanced details');
    const amdGPUs = await gpuDetector.detectAMDGPUsAdvanced();
    res.json({
      message: 'AMD GPUs detected',
      count: amdGPUs.length,
      gpus: amdGPUs
    });
  })
);

// GPU使用状況の取得
router.get('/:id/usage', asyncHandler(async (req, res) => {
  if (!requireService(vgpuManager, res)) return;
  const gpuId = req.params.id;
  logger.info(`Fetching usage stats for GPU: ${gpuId}`);
  const usageStats = await vgpuManager.getGPUUsageStats(gpuId);
  if (!usageStats) {
    return res.status(404).json({ error: 'GPU usage stats not found' });
  }
  res.json({ message: 'Fetched GPU usage stats', gpuId, usageStats });
}));

// GPUのベンチマーク結果を取得
router.get('/:id/benchmark', asyncHandler(async (req, res) => {
  if (!requireService(vgpuManager, res)) return;
  const gpuId = req.params.id;
  logger.info(`Fetching benchmark results for GPU: ${gpuId}`);
  const benchmarkResults = await vgpuManager.getGPUBenchmarkResults(gpuId);
  if (!benchmarkResults) {
    return res.status(404).json({ error: 'GPU benchmark results not found' });
  }
  res.json(benchmarkResults);
}));

// GPUのベンチマークを実行 (認証必須)
router.post('/:id/benchmark',
  authenticateJWT,
  asyncHandler(async (req, res) => {
    if (!requireService(vgpuManager, res)) return;
    const gpuId = req.params.id;
    const VALID_BENCHMARK_TYPES = new Set(['standard', 'compute', 'memory', 'render']);
    const benchmarkType = req.body.type || 'standard';
    if (!VALID_BENCHMARK_TYPES.has(benchmarkType)) {
      return res.status(400).json({ error: `Invalid benchmark type. Allowed: ${[...VALID_BENCHMARK_TYPES].join(', ')}` });
    }
    logger.info(`Running ${benchmarkType} benchmark on GPU: ${gpuId}`);
    const benchmarkJob = await vgpuManager.runGPUBenchmark(gpuId, benchmarkType);
    res.json({
      message: 'Benchmark started',
      jobId: benchmarkJob.id,
      estimatedCompletionTime: benchmarkJob.estimatedCompletionTime
    });
  })
);

module.exports = router;
