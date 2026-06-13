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
  // 占有状況の注釈: 現時刻と時間帯が重複する BLOCKING 注文がある GPU は available=false。
  // 二重予約は注文作成時に 409 で拒否されるため、ここは閲覧時のヒント表示。
  const OrderRepository = require('../../../db/json/OrderRepository');
  const BLOCKING = new Set(['pending', 'matched', 'active']);
  const nowMs = Date.now();
  const occupiedGpuIds = new Set(
    OrderRepository.getAll().filter(o => {
      if (!BLOCKING.has(o.status)) return false;
      const slotStart = new Date(o.scheduledStartAt || o.createdAt).getTime();
      const slotEnd = slotStart + (o.durationMinutes || 0) * 60 * 1000;
      return slotStart <= nowMs && slotEnd > nowMs;
    }).map(o => o.gpuId)
  );
  // available: プロバイダが手動で false に設定している場合はそれを優先し、
  // そうでなければ現在時刻に重複注文がない場合は true とする（動的稼働チェック）。
  gpus = gpus.map(gpu => ({
    ...gpu,
    available: gpu.available === false ? false : !occupiedGpuIds.has(gpu.id),
  }));
  // ?available=true で空き GPU のみに絞り込み
  if (req.query.available === 'true') {
    gpus = gpus.filter(gpu => gpu.available);
  }
  // ?minRating=N (1–5) で平均評価が N 以上の GPU のみに絞り込み（レビューなし GPU は除外）
  // レーティングは sort=rating でも使うので先に計算しておく
  const reviewMap = new Map(); // gpuId → { sum, count }
  for (const o of OrderRepository.getAll()) {
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
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  gpus = gpus.slice(offset, offset + limit);
  // レスポンスに追加情報を含める
  const response = {
    message: 'Fetched available GPUs',
    total: totalCount,
    limit,
    offset,
    gpus: gpus.map(({ apiKey, ...gpu }) => gpu), // apiKeyなどの漏洩防止
    timestamp: new Date().toISOString()
  };
  res.json(response);
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
  // レーティング集計（レビュー付き完了注文から on-the-fly 計算）
  const OrderRepository = require('../../../db/json/OrderRepository');
  const reviewOrders = OrderRepository.getAll().filter(o => o.gpuId === gpuId && o.review);
  const ratingCount = reviewOrders.length;
  const ratingAverage = ratingCount > 0
    ? Math.round((reviewOrders.reduce((s, o) => s + o.review.rating, 0) / ratingCount) * 10) / 10
    : null;
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
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  const reviews = OrderRepository.getAll()
    .filter(o => o.gpuId === gpuId && o.review)
    .sort((a, b) => b.review.reviewedAt.localeCompare(a.review.reviewedAt))
    .map(o => ({ orderId: o.id, ...o.review }));

  const total = reviews.length;
  const page = reviews.slice(offset, offset + limit);
  const ratingAverage = total > 0
    ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / total) * 10) / 10
    : null;

  res.json({ gpuId, total, limit, offset, ratingAverage, reviews: page });
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
    // 重複スペック登録防止
    const duplicate = GpuRepository.getAll().find(g =>
      g.id !== gpuId &&
      g.name === sanitized.name &&
      g.memory === sanitized.memory &&
      g.providerId === gpu.providerId
    );
    if (duplicate) {
      return res.status(409).json({ error: 'Duplicate GPU spec already registered' });
    }
    // GPU情報を更新
    const updatedGPU = GpuRepository.update(gpuId, { ...gpu, ...sanitized });
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

  const OrderRepository = require('../../../db/json/OrderRepository');
  const BLOCKING = new Set(['pending', 'matched', 'active']);

  const blockedSlots = OrderRepository.getAll()
    .filter(o => o.gpuId === gpuId && BLOCKING.has(o.status))
    .map(o => {
      const slotStart = new Date(o.scheduledStartAt || o.createdAt);
      const slotEnd = new Date(slotStart.getTime() + (o.durationMinutes || 0) * 60 * 1000);
      return { from: slotStart.toISOString(), to: slotEnd.toISOString(), orderId: o.id, status: o.status };
    })
    .filter(slot => new Date(slot.from) < to && new Date(slot.to) > from)
    .sort((a, b) => a.from.localeCompare(b.from));

  res.json({
    gpuId,
    from: from.toISOString(),
    to: to.toISOString(),
    blockedSlots,
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
