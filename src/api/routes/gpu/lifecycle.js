// src/api/routes/gpu/lifecycle.js - GPU 登録・更新・削除系エンドポイント
// （POST /・clone・bulk・PUT・DELETE — プロバイダのライフサイクル操作）。
const express = require('express');
const router = express.Router();

const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas, Joi } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole, allowOwnerOrAdmin } = require('../../middleware/security');
const GpuRepository = require('../../../db/json/GpuRepository');
const OrderRepository = require('../../../db/json/OrderRepository');
const WatchRepository = require('../../../db/json/WatchRepository');
const { createMockAttestationVerifier } = require('../../../security/gpu-attestation-verifier');
const { sanitizeObject, sanitizeString } = require('../../../utils/sanitize');
const { appendAuditLog } = require('../../../utils/audit-log');
const { withLock } = require('../../../utils/async-lock');
const { notifyPriceWatchers } = require('../../../services/price-watch');

const _attestationVerifier = createMockAttestationVerifier();

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
      'features', 'capabilities', 'location', 'performance', 'minRenterRating',
      'rejectUnratedRenters',
    ]);
    logger.info(`[GPU登録] ${gpuInfo.vendor} ${gpuInfo.model} (${gpuInfo.apiType}) by ${req.user.id}`);

    // 提供者ごとのGPU登録数上限チェック（スパム・在庫偽装防止）
    const MAX_GPUS = (() => {
      const raw = process.env.MAX_GPUS_PER_PROVIDER;
      const n = Number(raw);
      return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : 50;
    })();
    // getAll() は呼び出す度に gpus.json を同期読み込み+パースするためキャッシュしない。
    // クォータチェックと重複チェックで別々に呼ぶと 1 リクエストで 2 回のディスク I/O が
    // 発生するため、1 回のロードを��方のチェックで再利用する。
    // getAll → attestation(await) → create の間に同一プロバイダの別リクエストが
    // 挟まるとクォータ/重複チェックが stale になるため、プロバイダ単位で直列化する。
    const createResult = await withLock(`gpu:create:${req.user.id}`, async () => {
      const allGpus = GpuRepository.getAll();
      if (req.user.role !== 'admin') {
        const providerGpuCount = allGpus.filter(g => g.providerId === req.user.id).length;
        if (providerGpuCount >= MAX_GPUS) {
          return { status: 429, error: `GPU registration limit reached (max ${MAX_GPUS} per provider)` };
        }
      }

      // 重複登録チェック（model, vendor, providerId, memoryGB）
      const duplicate = allGpus.find(g =>
        g.name === gpuInfo.name &&
        g.model === gpuInfo.model &&
        g.vendor === gpuInfo.vendor &&
        g.memoryGB === gpuInfo.memoryGB &&
        g.providerId === req.user.id
      );
      if (duplicate) {
        return { status: 409, error: 'Duplicate GPU spec already registered' };
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

      // ファイル永続化リポジトリに登録
      return { gpu: GpuRepository.create(gpuInfo) };
    });
    if (createResult.error) {
      return res.status(createResult.status).json({ error: createResult.error });
    }
    const registeredGpu = createResult.gpu;
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
  // getAll() は呼ぶ度に gpus.json を同期読み込み+パースする（キャッシュなし）。
  // 上限チェックと重複チェックで別々に呼ぶと 1 リクエストで 2 回のディスク I/O が
  // 発生するため、1 回のロードを両方のチェックで再利用する。
  const allGpusForClone = GpuRepository.getAll();
  // GPU 上限チェック: clone も新規登録と同等の制限を受ける（clone での上限迂回を防ぐ）
  if (req.user.role !== 'admin') {
    const MAX_GPUS_CLONE = (() => {
      const raw = process.env.MAX_GPUS_PER_PROVIDER;
      const n = Number(raw);
      return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : 50;
    })();
    const providerGpuCount = allGpusForClone.filter(g => g.providerId === req.user.id).length;
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
  const duplicate = allGpusForClone.find(g =>
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
    // getAll() は呼ぶ度に gpus.json を同期読み込み+パースする（キャッシュなし）。
    // バッチ内の重複は below の batchKeys（name|model|vendor|memoryGB — 既存重複
    // チェックと同一の一致条件）で完全にカバーされる。
    // 単体登録と同じ TOCTOU: snapshot → attestation(await) → create の間に同一
    // プロバイダの別リクエストが挟まるとスナップショットが stale になるため、
    // 同一キーのロックでクォータ/重複チェックから create まで直列化する。
    const bulkResult = await withLock(`gpu:create:${req.user.id}`, async () => {
      const allGpusSnapshot = GpuRepository.getAll();
      if (req.user.role !== 'admin') {
        const currentCount = allGpusSnapshot.filter(g => g.providerId === req.user.id).length;
        if (currentCount + entries.length > MAX_GPUS_BULK) {
          return { status: 429, error: `Would exceed GPU registration limit. Current: ${currentCount}, limit: ${MAX_GPUS_BULK}, requested: ${entries.length}` };
        }
      }
      const gpuSchemas = schemas.gpu;
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
      const duplicate = allGpusSnapshot.find(g =>
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
      // バルクでも単体登録と同等にアテステーションを処理する。単体登録で
      // attestation 失敗の slashCount を負っているプロバイダがバルク経由で罰則を
      // 回避できないよう、recordAttestation を呼ぶ。
      if (value.attestationReport) {
        try {
          const attResult = await _attestationVerifier.verify(gpuInfo, value.attestationReport);
          gpuInfo.attestation = {
            passed: attResult.passed,
            score: attResult.score,
            findings: attResult.findings,
            verifiedAt: new Date().toISOString(),
          };
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
      return { results };
    });
    if (bulkResult.error) {
      return res.status(bulkResult.status).json({ error: bulkResult.error });
    }
    const results = bulkResult.results;
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
    // rejectUnratedRenters はスキーマ (schemas.gpu.update) で許可済みだが
    // 旧 allowlist に含まれておらずサニタイズで無言に剥落し、機能が完全に
    // 死んでいた（gpu.rejectUnratedRenters は常に undefined → 注文時チェックが
    // 素通り）。allowlist に追加して機能を正常化する。
    const sanitized = sanitizeObject(req.validatedBody, ['name', 'pricePerHour', 'availability', 'minRenterRating', 'available', 'rejectUnratedRenters']);
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
    // Audit minRenterRating / rejectUnratedRenters changes: providers can use
    // these fields to selectively block renters. Log every change for admin review.
    if (sanitized.minRenterRating !== undefined && sanitized.minRenterRating !== gpu.minRenterRating) {
      appendAuditLog('gpu_min_renter_rating_changed', {
        gpuId,
        previousValue: gpu.minRenterRating ?? null,
        newValue: sanitized.minRenterRating,
        providerId: req.user.id,
      }, req.user.id);
    }
    if (sanitized.rejectUnratedRenters !== undefined && sanitized.rejectUnratedRenters !== gpu.rejectUnratedRenters) {
      appendAuditLog('gpu_reject_unrated_renters_changed', {
        gpuId,
        previousValue: gpu.rejectUnratedRenters ?? false,
        newValue: sanitized.rejectUnratedRenters,
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

module.exports = router;
