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
  // 価格順にソート
  gpus.sort((a, b) => a.pricePerHour - b.pricePerHour);
  // レスポンスに追加情報を含める
  const response = {
    message: 'Fetched available GPUs',
    total: gpus.length,
    gpus: gpus.map(({ apiKey, ...gpu }) => gpu), // apiKeyなどの漏洩防止
    timestamp: new Date().toISOString()
  };
  res.json(response);
}));

// 特定のGPUの詳細情報を取得
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
  // レスポンスを構築（apiKey等除外）
  const { apiKey, ...gpuSafe } = gpu;
  const response = {
    message: 'Fetched GPU detail',
    gpu: { ...gpuSafe, details, usageStats, availability }
  };
  res.json(response);
}));

const { sanitizeObject } = require('../../../utils/sanitize');

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
      'features', 'capabilities', 'location', 'performance'
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
    const sanitized = sanitizeObject(req.body, ['name']);
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
