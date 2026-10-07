// SLA・障害履歴ダッシュボードAPI
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { authenticateJWT, checkRole } = require('./middleware/security');
const { resolveDataDir } = require('../db/json/data-dir');

const SLA_PATH = path.join(resolveDataDir(), 'sla.json');
const ANOMALY_HISTORY_PATH = path.join(__dirname, '../../logs/anomaly-history.json');

// i7（ホットパスの同期 I/O）対策: /sla は認証ユーザなら誰でも打てるため、
// リクエスト毎の全文 readFileSync+JSON.parse は stat 指紋ゲートで回避する
// （notification-settings.js/auth-user-lookup.js と同じ規約）。
// ファイルが変わった時だけ再パースし、静寂時の I/O をゼロにする。
const _cache = new Map(); // path -> { stamp, parsed }
function _stamp(file) {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch (_) {
    return null; // ファイル不在/stat 失敗
  }
}
function loadJsonCached(file) {
  const stamp = _stamp(file);
  if (stamp === null) return null; // 不在 — 呼び出し側の既定値へ
  const hit = _cache.get(file);
  if (hit && hit.stamp === stamp) return hit.parsed;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (_) {
    // 破損ファイルはキャッシュしない — 修復されれば次回で回復する
  }
  if (parsed !== null) _cache.set(file, { stamp, parsed });
  return parsed;
}

// SLA統計取得API（認証必須 — 内部稼働状況のため）
router.get('/sla', authenticateJWT, (req, res) => {
  const sla = loadJsonCached(SLA_PATH);
  if (!sla || typeof sla !== 'object') return res.json({ uptimeRate: 1, up: 0, down: 0, total: 0 });
  const rate = sla.total ? (sla.up / sla.total) : 1;
  res.json({ uptimeRate: rate, up: sla.up, down: sla.down, total: sla.total });
});

// 障害履歴取得API（管理者のみ — 詳細なエラー情報が含まれるため）
router.get('/anomalies', authenticateJWT, checkRole(['admin']), (req, res) => {
  const history = loadJsonCached(ANOMALY_HISTORY_PATH);
  if (!Array.isArray(history)) return res.json([]);
  res.json(history.slice(-100).reverse()); // 直近100件のみ返す
});

module.exports = { router, _testInternals: { loadJsonCached, _cache } };
