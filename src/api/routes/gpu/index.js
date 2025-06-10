// src/api/routes/gpu/index.js - GPU関連APIルート
const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole } = require('../../middleware/security');

// GPU検出・管理クラスのインポート
const { ExtendedGPUDetector } = require('../../../core/gpu-detector-extended');
const { VirtualGPUManager } = require('../../../../virtual-gpu-manager');
const { P2PNetwork } = require('../../../../p2p-network');
// ファイルベースJSONストレージリポジトリ
const GpuRepository = require('../../../db/json/GpuRepository');

// シングルトンインスタンス
const gpuDetector = new ExtendedGPUDetector();
const vgpuManager = new VirtualGPUManager();
const p2pNetwork = new P2PNetwork();

// 利用可能なGPU一覧を取得
router.get('/', asyncHandler(async (req, res) => {
  logger.info('Fetching available GPUs');
  // クエリパラメータからフィルタリング条件を取得
  const filters = {
    minMemoryGB: req.query.minMemoryGB ? parseInt(req.query.minMemoryGB, 10) : 0,
    vendor: req.query.vendor || null,
    maxPrice: req.query.maxPrice ? parseFloat(req.query.maxPrice) : null,
    features: req.query.features ? JSON.parse(req.query.features) : null,
  };
  // ファイル永続化されたGPUリストを取得
  let gpus = GpuRepository.getAll();
  // P2Pネットワークから提供されているGPUも取得
  const p2pGpus = await p2pNetwork.getAvailableGPUs();
  // 両方のリストを結合
  gpus = [...gpus, ...p2pGpus];
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
  if (!gpu) {
    // P2Pネットワークからも検索
    gpu = await p2pNetwork.getGPUById(gpuId);
  }
  if (!gpu) {
    return res.status(404).json({ error: 'GPU not found' });
  }
  // 詳細情報取得
  const details = await vgpuManager.getGPUDetails(gpuId);
  const usageStats = await vgpuManager.getGPUUsageStats(gpuId);
  // レスポンスを構築（apiKey等除外）
  const { apiKey, ...gpuSafe } = gpu;
  const response = {
    message: 'Fetched GPU detail',
    gpu: {
      ...gpuSafe,
      details,
      usageStats,
      availability: await vgpuManager.getGPUAvailability(gpuId)
    }
  };
  res.json(response);
}));

const { apiKeyAuth } = require('../../middleware/security');
const { sanitizeObject } = require('../../../utils/sanitize');

// GPU出品登録 (認証必須)
router.post('/', 
  apiKeyAuth,
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
    // P2Pネットワークへアナウンス
    await p2pNetwork.announceGPU(gpuInfo);
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
      gpu: gpuSafe
    });
  })
);

// GPU情報更新 (認証必須)
router.put('/:id',
  apiKeyAuth,
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
  apiKeyAuth,
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
    // P2Pネットワークに削除を通知
    await p2pNetwork.removeGPU(gpuId);
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
    logger.info('Detecting system GPUs');
    
    // GPUを検出
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
    logger.info('Detecting AMD GPUs with advanced details');
    
    // AMD GPUを詳細検出
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
  const gpuId = req.params.id;
  logger.info(`Fetching usage stats for GPU: ${gpuId}`);
  
  // GPU使用状況を取得
  const usageStats = await vgpuManager.getGPUUsageStats(gpuId);
  
  if (!usageStats) {
    return res.status(404).json({ error: 'GPU usage stats not found' });
  }
  
  res.json({
    message: 'Fetched GPU usage stats',
    gpuId,
    usageStats
  });
}));

// GPUのベンチマーク結果を取得
router.get('/:id/benchmark', asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  logger.info(`Fetching benchmark results for GPU: ${gpuId}`);
  
  // ベンチマーク結果を取得
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
    const gpuId = req.params.id;
    const benchmarkType = req.body.type || 'standard';
    logger.info(`Running ${benchmarkType} benchmark on GPU: ${gpuId}`);
    
    // ベンチマークを実行
    const benchmarkJob = await vgpuManager.runGPUBenchmark(gpuId, benchmarkType);
    
    res.json({ 
      message: 'Benchmark started', 
      jobId: benchmarkJob.id,
      estimatedCompletionTime: benchmarkJob.estimatedCompletionTime
    });
  })
);

module.exports = router;
