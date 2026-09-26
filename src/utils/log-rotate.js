// src/utils/log-rotate.js - 追記型ログのサイズ上限ローテーション
// winston transports.File は maxsize/maxFiles で回転するが、appendFileSync で
// 手動追記するログ（access-audit.log / db-access.log / gpu-events.log 等）には
// その機構が無く、無制限に肥大してディスク枯渇（ログ DoS）になり得た。
// appendFileSync と同じ同期 API で、追記前に statSync → 閾値超過なら 1 世代
// ローテート（.1）する。複数世代や世代圧縮は意図的に省く: これらは補助監査ログで、
// 1 世代保持で「直前ローテーション境界前後の記録」を十分に追える。
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // winston の maxsize=10MB と揃える

/**
 * サイズ上限付きで行を追記する。
 * @param {string} filePath 追記先
 * @param {string} line 追記する行（改行含む）
 * @param {{maxBytes?: number}} [opts]
 */
function appendRotated(filePath, line, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  try {
    const st = fs.statSync(filePath);
    if (st.size > maxBytes) {
      // .1 を上書き（2世代目以降は切り捨て）。rename は同一 fs 上で atomic。
      fs.renameSync(filePath, `${filePath}.1`);
    }
  } catch (e) {
    // ENOENT（未作成）は正常。stat 失敗時はローテートせず追記に進む。
  }
  fs.appendFileSync(filePath, line);
}

/** ログディレクトリを初回のみ作成する（リクエスト毎の mkdirSync 回避用）。 */
const _readyDirs = new Set();
function ensureLogDir(filePath) {
  const dir = path.dirname(filePath);
  if (_readyDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  _readyDirs.add(dir);
}

module.exports = { appendRotated, ensureLogDir, DEFAULT_MAX_BYTES };
