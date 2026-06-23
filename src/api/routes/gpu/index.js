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
const { sanitizeObject, sanitizeString } = require('../../../utils/sanitize');
const { withLock } = require('../../../utils/async-lock');
const { appendAuditLog } = require('../../../utils/audit-log');
// 価格ウォッチ（値下げアラート）
const WatchRepository = require('../../../db/json/WatchRepository');
const { notifyPriceWatchers, notifyWatchJustCreated } = require('../../../services/price-watch');

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
      const raw = Number(o.review.rating);
      if (!Number.isFinite(raw)) continue;
      const clamped = Math.min(5, Math.max(1, raw));
      const cur = reviewMap.get(o.gpuId) || { sum: 0, count: 0 };
      cur.sum += clamped;
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
  if (!gpu && p2pNetwork && typeof p2pNetwork.getGPUById === 'function') {
    // P2Pネットワークからも検索（P2P無効時はスキップ）
    try { gpu = await p2pNetwork.getGPUById(gpuId); } catch (_) {}
  }
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
  const response = {
    message: 'Fetched GPU detail',
    gpu: {
      ...gpuSafe,
      ...(viewerIsOwnerOrAdmin ? { providerId, manualBlocks } : {}),
      details, usageStats, availability,
      rating: { average: ratingAverage, count: ratingCount }
    }
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

  // レビュー本体を spread すると reviewerId（借り手の UUID）が漏れ、認証済み任意ユーザーが
   // GPU 単位で借り手を列挙できる（renter-profile と組合せて renter プロファイリング可能）。
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
  // 借り手 userId を生で返すと、安価な GPU を撒餌に出品して借り手 UUID を量産収集する
  // 大量列挙攻撃が成立する（renter-profile と組合せて prof作成可能）。
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

    // GPU アテステーション（任意）— validatedBody から読む（Joi で許可フィールドを限定済み）。
    // req.body から直接読むと攻撃者が任意フィールドを注入し検証を欺けるため必ず validated 側を使う。
    const attestationReport = (req.validatedBody || {}).attestationReport;
    if (attestationReport) {
      try {
        const attResult = await _attestationVerifier.verify(gpuInfo, attestationReport);
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
  // GPU 上限チェック: clone も新規登録と同等の制限を受ける（clone での上限迂回を防ぐ）
  if (req.user.role !== 'admin') {
    const MAX_GPUS_CLONE = (() => {
      const raw = process.env.MAX_GPUS_PER_PROVIDER;
      const n = Number(raw);
      return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : 50;
    })();
    const providerGpuCount = GpuRepository.getAll().filter(g => g.providerId === req.user.id).length;
    if (providerGpuCount >= MAX_GPUS_CLONE) {
      return res.status(429).json({ error: `GPU registration limit reached (max ${MAX_GPUS_CLONE} per provider)` });
    }
  }
  const {
    id: _id, providerId: _p, createdAt: _c, updatedAt: _u, attestation: _a, manualBlocks: _b,
    apiKey: _ak, available: _av, ...specFields  // available を除外 → クローンは常にオンライン
  } = source;
  // Sanitize and type-check: req.query.name may be an array (HTTP param pollution
  // via ?name[]=foo&name[]=<xss>). Only accept string values; sanitize against XSS.
  const rawName = (typeof req.body.name === 'string' ? req.body.name : null)
    || (typeof req.query.name === 'string' ? req.query.name : null)
    || `${source.name} (copy)`;
  const targetName = sanitizeString(rawName).slice(0, 128);
  // 重複スペック禁止: 単体 register / PUT は (name, model, vendor, memoryGB, providerId) で
  // 一意性を強制している。clone はこれを skip していたためマーケット重複・検索順位操作・
  // 分析データ汚染を起こせた。
  const duplicate = GpuRepository.getAll().find(g =>
    g.providerId === req.user.id &&
    g.name === targetName &&
    g.model === source.model &&
    g.vendor === source.vendor &&
    g.memoryGB === source.memoryGB
  );
  if (duplicate) {
    return res.status(409).json({ error: 'A GPU with this name and spec is already registered for this provider' });
  }
  // ソースは旧スキーマで登録されている可能性があるため、register スキーマを丸ごと
  // 適用すると必須フィールド欠落で 400 が頻発する。stripUnknown + presence:'optional'
  // で「未知フィールドは捨てる、ただし値が来たものはレンジ検証する」運用に落とす。
  // 目的は legacy/out-of-band フィールドが新規 GPU レコードに混入するのを防ぐこと。
  const { error: cloneValErr, value: validatedClone } = schemas.gpu.register
    .fork(Object.keys(schemas.gpu.register.describe().keys || {}), (s) => s.optional())
    .validate({ ...specFields, name: targetName }, { abortEarly: false, stripUnknown: true });
  if (cloneValErr) {
    return res.status(400).json({
      error: 'Cloned spec failed validation: ' + cloneValErr.details.map(d => d.message).join('; '),
    });
  }
  const cloned = GpuRepository.create({
    ...validatedClone,
    providerId: req.user.id,
    available: true,  // ソースが offline でもクローンは online 状態で開始
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
      // バルクでも単体登録と同等にアテステーションを処理する。
      // 旧実装は単に { passed:false } を埋めて recordAttestation を呼ばないため、
      // 単体登録で attestation 失敗の slashCount を負っているプロバイダがバルクに
      // 切り替えることでレピュテーション罰則を回避できる reputation laundering 経路だった。
      if (value.attestationReport) {
        try {
          const attResult = await _attestationVerifier.verify(gpuInfo, value.attestationReport);
          gpuInfo.attestation = {
            passed: attResult.passed,
            score: attResult.score,
            findings: attResult.findings,
            verifiedAt: new Date().toISOString(),
          };
          try { createReputationService().recordAttestation(req.user.id, attResult.passed); } catch (_) {}
        } catch (attErr) {
          gpuInfo.attestation = {
            passed: false, score: 0,
            findings: ['verifier error: ' + attErr.message],
            verifiedAt: new Date().toISOString(),
          };
        }
      } else {
        gpuInfo.attestation = { passed: false, score: 0, findings: ['no attestation report provided'], verifiedAt: null };
      }
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
    // validatedBody は Joi で許可フィールドだけに絞られているため、これを起点にする。
    // 旧コードは req.body をそのまま spread しており、providerId/attestation/apiKey/id 等の
    // 任意フィールドをクライアントが上書きできるマスアサインメント脆弱性があった
    // （GPU 所有権の奪取・偽アテステーション・価格上限回避が可能だった）。
    const sanitized = sanitizeObject(req.validatedBody, ['name', 'pricePerHour', 'availability', 'minRenterRating', 'available']);
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
    // Audit minRenterRating changes: providers can use this field to selectively
    // block specific renters. Log every change for admin review.
    if (sanitized.minRenterRating !== undefined && sanitized.minRenterRating !== gpu.minRenterRating) {
      appendAuditLog('gpu_min_renter_rating_changed', {
        gpuId,
        previousValue: gpu.minRenterRating ?? null,
        newValue: sanitized.minRenterRating,
        providerId: req.user.id,
      }, req.user.id);
    }
    // GPU情報を更新
    const previousPrice = gpu.pricePerHour;
    const previousAvailable = gpu.available;
    const updatedGPU = GpuRepository.update(gpuId, sanitized);
    logger.info(`GPU updated: ${gpuId}`);
    // 値下げ / 空き復帰を検知: fire-and-forget（通知失敗で更新レスポンスをブロックしない）
    setImmediate(() => notifyPriceWatchers(updatedGPU, { previousPrice, previousAvailable }));
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

    // アクティブ・係争中の注文がある場合は削除を拒否（孤立注文・証拠隠滅を防ぐ）
    // 'disputed' を含めることでプロバイダが係争中に GPU を削除して管理者の裁定材料を
    // 消滅させる griefing パスを塞ぐ。
    const OrderRepository = require('../../../db/json/OrderRepository');
    const BLOCKING = new Set(['pending', 'matched', 'active', 'disputed']);
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
    // 価格ウォッチの後始末: GPU が消えたウォッチは二度と発火せず、watches.json に
    // 永久に残るストレージリークになる。削除と同時に孤児ウォッチを除去する。
    try {
      const orphaned = WatchRepository.getByGpu(gpuId) || [];
      for (const w of orphaned) {
        try { WatchRepository.delete(w.id); } catch (_) {}
      }
    } catch (_) { /* ウォッチ後始末の失敗で GPU 削除レスポンスを妨げない */ }
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
router.post('/:id/block',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
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

  // TOCTOU防止: 並行 add が上限チェックを同時に通過し cap を超過する（100→101+）のと
  // 後着の write が先着 write の追加ブロックを上書き消去するのを防ぐ。
  // ロック内で GPU を再取得し最新の manualBlocks 配列に対して上限を評価する。
  const MAX_BLOCKS_PER_GPU = 100;
  return withLock(`gpu:${gpuId}:blocks`, async () => {
    const freshGpu = GpuRepository.getById(gpuId);
    const existing = Array.isArray(freshGpu && freshGpu.manualBlocks) ? freshGpu.manualBlocks : [];
    if (existing.length >= MAX_BLOCKS_PER_GPU) {
      return res.status(429).json({ error: `Cannot add more than ${MAX_BLOCKS_PER_GPU} manual blocks per GPU. Remove old blocks first.` });
    }
    GpuRepository.update(gpuId, { manualBlocks: [...existing, block] });
    return res.status(201).json({ block });
  });
}));

// GPU 手動ブロック削除
// DELETE /gpus/:id/block/:blockId — 認証必須（GPU オーナーまたは管理者）
router.delete('/:id/block/:blockId',
  authenticateJWT,
  // id は実際の DB ルックアップキーなので UUID で厳格に検証する。
  // blockId は manualBlocks の .find() 文字列比較にしか使われず（注入面なし）、
  // 存在しない blockId は 404 Not Found として返すのが正しい意味論。よって UUID 厳格化
  // ではなく長さ上限付きの不透明文字列として受け入れ、ハンドラに 404 判定を委ねる。
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required(), blockId: Joi.string().max(128).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  const gpu = GpuRepository.getById(gpuId);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });
  if (req.user.role !== 'admin' && gpu.providerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const blockId = req.params.blockId;
  // TOCTOU防止: 並行 add+delete が互いの変更を上書き消去するのを防ぐ。add と同じキーでシリアライズ。
  return withLock(`gpu:${gpuId}:blocks`, async () => {
    const freshGpu = GpuRepository.getById(gpuId);
    const existing = Array.isArray(freshGpu && freshGpu.manualBlocks) ? freshGpu.manualBlocks : [];
    const idx = existing.findIndex(b => b.id === blockId);
    if (idx === -1) return res.status(404).json({ error: 'Block not found' });
    GpuRepository.update(gpuId, { manualBlocks: existing.filter(b => b.id !== blockId) });
    return res.status(200).json({ message: 'Block removed' });
  });
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

// システムが検出したGPUの一覧を取得 (管理者のみ)
// 旧実装は認証必須のみで一般ユーザーがホストの物理 GPU 在庫を列挙できた
// （ドライバ・ファームウェア・PCI ID 等のサーバー側偵察情報の漏洩）。
router.get('/system/detected',
  authenticateJWT,
  checkRole(['admin']),
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

// AMD GPUの詳細検出 (管理者のみ)
router.get('/system/amd',
  authenticateJWT,
  checkRole(['admin']),
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

// GPU使用状況の取得 (オーナー/管理者のみ)
// 旧実装は無認証で誰でも借り手のライブテレメトリ（CPU/メモリ/利用率/温度）を
// ポーリングでき、稼働パターンの de-anonymize やサイドチャネル収集が可能だった。
router.get('/:id/usage',
  authenticateJWT,
  allowOwnerOrAdmin((req) => GpuRepository.getById(req.params.id)),
  asyncHandler(async (req, res) => {
    if (!requireService(vgpuManager, res)) return;
    const gpuId = req.params.id;
    logger.info(`Fetching usage stats for GPU: ${gpuId}`);
    const usageStats = await vgpuManager.getGPUUsageStats(gpuId);
    if (!usageStats) {
      return res.status(404).json({ error: 'GPU usage stats not found' });
    }
    res.json({ message: 'Fetched GPU usage stats', gpuId, usageStats });
  })
);

// GPUのベンチマーク結果を取得 (オーナー/管理者のみ — 過去計測値もテレメトリ扱い)
router.get('/:id/benchmark',
  authenticateJWT,
  allowOwnerOrAdmin((req) => GpuRepository.getById(req.params.id)),
  asyncHandler(async (req, res) => {
    if (!requireService(vgpuManager, res)) return;
    const gpuId = req.params.id;
    logger.info(`Fetching benchmark results for GPU: ${gpuId}`);
    const benchmarkResults = await vgpuManager.getGPUBenchmarkResults(gpuId);
    if (!benchmarkResults) {
      return res.status(404).json({ error: 'GPU benchmark results not found' });
    }
    res.json(benchmarkResults);
  })
);

// GPUのベンチマークを実行 (オーナー/管理者のみ)
// allowOwnerOrAdmin なしだと任意の認証済みユーザーが他プロバイダの GPU で
// ベンチマークをトリガーでき、負荷攻撃・レピュテーション汚染の経路になる。
router.post('/:id/benchmark',
  authenticateJWT,
  allowOwnerOrAdmin((req) => GpuRepository.getById(req.params.id)),
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

// GPU 価格ウォッチ登録（値下げアラート）
// POST /gpus/:id/watch — 認証必須（自分が提供していないGPUのみ登録可）
router.post('/:id/watch',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const gpuId = req.params.id;
    const gpu = GpuRepository.getById(gpuId);
    if (!gpu) return res.status(404).json({ error: 'GPU not found' });
    if (gpu.providerId === req.user.id) {
      return res.status(403).json({ error: 'Providers cannot watch their own GPUs' });
    }
    const { targetPrice } = req.body;
    if (typeof targetPrice !== 'number' || !Number.isFinite(targetPrice) || targetPrice <= 0) {
      return res.status(400).json({ error: '"targetPrice" must be a positive number' });
    }
    // 1ユーザーあたりのウォッチ上限。無制限だと watches.json を無限に膨張させる
    // リソース枯渇（DoS）経路になるため、manualBlocks と同様に上限を設ける。
    // ロックはユーザー単位（gpu 単位ではない）にして、別 GPU への並行登録が
    // 上限チェックを同時通過して cap を超過する TOCTOU を防ぐ。
    const MAX_WATCHES_PER_USER = 200;
    return withLock(`watch:${req.user.id}`, async () => {
      const userWatches = WatchRepository.getByUser(req.user.id) || [];
      const existing = userWatches.find(w => w.gpuId === gpuId);
      let watch;
      if (existing) {
        watch = WatchRepository.update(existing.id, { targetPrice, lastNotifiedPrice: null, lastNotifiedAt: null });
        // ウォッチ更新後も即時チェック: 新 targetPrice が現在価格以下なら即時通知
        setImmediate(() => notifyWatchJustCreated(gpu, watch));
        return res.status(200).json({ watch });
      }
      if (userWatches.length >= MAX_WATCHES_PER_USER) {
        return res.status(429).json({ error: `Cannot watch more than ${MAX_WATCHES_PER_USER} GPUs. Remove an existing watch first.` });
      }
      const { v4: uuidv4 } = require('uuid');
      watch = WatchRepository.create({
        id: uuidv4(),
        userId: req.user.id,
        gpuId,
        targetPrice,
        lastNotifiedPrice: null,
        lastNotifiedAt: null,
        createdAt: new Date().toISOString(),
      });
      // ウォッチ作成直後: 現在価格がすでに目標以下なら即時通知。
      // notifyPriceWatchers は「価格が変化した瞬間」にのみ発火するため、
      // 登録時点で目標達成済みだと以後価格変動がなければ永久に沈黙する UX バグを修正。
      setImmediate(() => notifyWatchJustCreated(gpu, watch));
      return res.status(201).json({ watch });
    });
  })
);

// GPU 価格ウォッチ削除
// DELETE /gpus/:id/watch — 認証必須（自分のウォッチのみ削除可）
router.delete('/:id/watch',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const gpuId = req.params.id;
    const gpu = GpuRepository.getById(gpuId);
    if (!gpu) return res.status(404).json({ error: 'GPU not found' });
    const existing = WatchRepository.getAll().find(w => w.userId === req.user.id && w.gpuId === gpuId);
    if (!existing) return res.status(404).json({ error: 'Watch not found' });
    WatchRepository.delete(existing.id);
    return res.status(200).json({ message: 'Watch removed' });
  })
);

// 自分の GPU ウォッチ取得
// GET /gpus/:id/watch — 認証必須
router.get('/:id/watch',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const gpuId = req.params.id;
    const gpu = GpuRepository.getById(gpuId);
    if (!gpu) return res.status(404).json({ error: 'GPU not found' });
    const watch = WatchRepository.getAll().find(w => w.userId === req.user.id && w.gpuId === gpuId);
    if (!watch) return res.status(404).json({ error: 'Watch not found' });
    return res.json({ watch });
  })
);

module.exports = router;
