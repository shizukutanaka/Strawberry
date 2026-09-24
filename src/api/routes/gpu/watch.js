// src/api/routes/gpu/watch.js - GPU 価格ウォッチ系エンドポイント
// （値下がり・再販通知の登録・解除・一覧）。
const express = require('express');
const router = express.Router();

const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas } = require('../../../utils/validator');
const { authenticateJWT } = require('../../middleware/security');
const GpuRepository = require('../../../db/json/GpuRepository');
const WatchRepository = require('../../../db/json/WatchRepository');
const { notifyPriceWatchers, notifyWatchJustCreated } = require('../../../services/price-watch');
const { withLock } = require('../../../utils/async-lock');
const { v4: uuidv4 } = require('uuid');

router.post('/:id/watch',
  authenticateJWT,
  validateMiddleware(schemas.idParam, 'params'),
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
  validateMiddleware(schemas.idParam, 'params'),
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
  validateMiddleware(schemas.idParam, 'params'),
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
