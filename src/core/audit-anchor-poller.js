// src/core/audit-anchor-poller.js
// 監査ログの定期 Merkle アンカー + OTS 提出ループ（§18）。
// audit-anchor.js の増分アンカー → ots-submitter.js で公開カレンダーへ提出し、
// pending receipts の Bitcoin 確定確認（upgrade）も同じ周期で行う。
// 全失敗は warn ログのみ — 外部カレンダー障害でプロセスを落とさない。
const { anchorAndSubmit, upgradePending } = require('../security/ots-submitter');
const { logger } = require('../utils/logger');

// 既定 6 時間。監査ログは高頻度ではないため緩い周期で十分（OpenTimestamps 側の
// Bitcoin 確定も数時間単位）。AUDIT_ANCHOR_INTERVAL_MS で上書き可能。
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

let _timer = null;
let _running = false;

async function tick() {
  if (_running) return; // 前回が残っていればスキップ（再入防止）
  _running = true;
  try {
    const anchored = await anchorAndSubmit();
    if (anchored && anchored.anchor) {
      logger.info(`audit anchor created: root=${anchored.anchor.root.slice(0, 16)}… entries=${anchored.anchor.count} ots=${anchored.receipt.status}`);
    }
    const up = await upgradePending();
    if (up.confirmed > 0) logger.info(`ots: ${up.confirmed} receipt(s) confirmed by Bitcoin attestation`);
  } catch (e) {
    logger.warn(`audit-anchor-poller tick failed: ${e.message}`);
  } finally {
    _running = false;
  }
}

function start(intervalMs = Number(process.env.AUDIT_ANCHOR_INTERVAL_MS) || DEFAULT_INTERVAL_MS) {
  if (_timer) return _timer;
  _timer = setInterval(tick, intervalMs);
  if (_timer.unref) _timer.unref();
  logger.info(`audit-anchor-poller started (interval ${intervalMs}ms)`);
  return _timer;
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, tick, DEFAULT_INTERVAL_MS };
