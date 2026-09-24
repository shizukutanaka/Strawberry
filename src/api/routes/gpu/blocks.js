// src/api/routes/gpu/blocks.js - GPU メンテナンスブロック系エンドポイント
// （期間ブロックの登録・解除 — 予約不可期間の管理）。
const express = require('express');
const router = express.Router();

const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas, Joi } = require('../../../utils/validator');
const { authenticateJWT } = require('../../middleware/security');
const GpuRepository = require('../../../db/json/GpuRepository');
const { withLock } = require('../../../utils/async-lock');
const { v4: uuidv4 } = require('uuid');

router.post('/:id/block',
  authenticateJWT,
  validateMiddleware(schemas.idParam, 'params'),
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

module.exports = router;
