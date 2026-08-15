// src/security/anchor-scheduler.js
// 監査ログの定期増分アンカリング・ジョブ（研究ドキュメント §18）。
//
// これが無かったために `audit-anchor.js` は完成していながら src/ のどこからも呼ばれず、
// アンカーが 1 つも生成されない状態だった（docs/SPECIFICATION.md は「残るは OTS への
// root 実提出のみ」と書いていたが、実際には結線自体が欠けていた）。
//
// 設計は src/core/invoice-poller.js と同型: setInterval + 再入ロック + unref。
const { logger } = require('../utils/logger');
const { appendAuditLog } = require('../utils/audit-log');
const auditAnchor = require('./audit-anchor');
const otsClient = require('./ots-client');
const fs = require('fs');
const path = require('path');

// 既定 1 時間。OTS は 1 件あたりのコストがほぼゼロだが、公共カレンダーへの礼儀として
// 過度に頻繁な提出はしない。短くするほど「まだアンカーされていない窓」は狭くなる。
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

let _timer = null;
let _running = false;

function intervalMs() {
  const v = Number(process.env.AUDIT_ANCHOR_INTERVAL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_INTERVAL_MS;
}

/** レシートの保存先。アンカー本体（追記専用 JSONL）を後から書き換えないよう別ファイルに持つ。 */
function receiptPath() {
  if (process.env.AUDIT_ANCHOR_RECEIPT_PATH) return process.env.AUDIT_ANCHOR_RECEIPT_PATH;
  const anchors = auditAnchor.anchorFilePath();
  return anchors.endsWith('.jsonl')
    ? `${anchors.slice(0, -6)}-receipts.jsonl`
    : `${anchors}-receipts.jsonl`;
}

/** レシートを追記する（root をキーにアンカーと join する）。 */
function appendReceipts(receipts, filePath = receiptPath()) {
  if (!Array.isArray(receipts) || receipts.length === 0) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = receipts.map((r) => JSON.stringify(r) + '\n').join('');
  fs.appendFileSync(filePath, lines);
}

/** 指定 root のレシート一覧を読む。 */
function readReceipts(rootHex, filePath = receiptPath()) {
  if (!fs.existsSync(filePath)) return [];
  const all = auditAnchor.parseEntries(fs.readFileSync(filePath, 'utf-8'));
  return rootHex ? all.filter((r) => r && r.root === rootHex) : all;
}

/**
 * 1 サイクル実行する: 増分アンカー生成 → OTS 提出 → レシート永続化。
 *
 * 監査ログ書き込みの再帰に注意: アンカー生成は自身も監査エントリを 1 件足すため、
 * その簿記エントリだけを理由に次サイクルが起動すると空回りが無限に続く。
 * 除外は audit-anchor.anchorNewEntries() 側で行っている（木には含めつつ起動判定から外す）。
 *
 * @returns {Promise<{anchor:object|null, receipts:Array}>}
 */
async function runOnce() {
  if (_running) return { anchor: null, receipts: [], skipped: 'already-running' };
  _running = true;
  try {
    let anchor;
    try {
      anchor = auditAnchor.anchorNewEntries();
    } catch (e) {
      logger.warn(`anchor-scheduler: failed to build anchor: ${e.message}`);
      return { anchor: null, receipts: [], error: e.message };
    }
    if (!anchor) return { anchor: null, receipts: [] };

    if (anchor.truncationDetected) {
      // ログが縮んでいた＝ローテーション/削除/切詰め。それ自体が重要な監査事実。
      appendAuditLog('audit_anchor_log_truncated', { resumedFromIndex: anchor.fromIndex });
      logger.warn('anchor-scheduler: audit log shrank; anchor index space was reset');
    }

    // OTS 提出はローカルのアンカー生成から独立させる。外部が落ちていてもアンカーは残す。
    let receipts = [];
    try {
      receipts = await otsClient.submitRoot(anchor.root);
      appendReceipts(receipts);
    } catch (e) {
      logger.warn(`anchor-scheduler: OTS submission error: ${e.message}`);
    }

    const submitted = receipts.filter((r) => r.status === 'submitted').length;
    appendAuditLog('audit_anchor_created', {
      root: anchor.root,
      count: anchor.count,
      fromIndex: anchor.fromIndex,
      toIndex: anchor.toIndex,
      otsSubmitted: submitted,
      otsAttempted: receipts.length,
    });
    logger.info(
      `anchor-scheduler: anchored entries ${anchor.fromIndex}-${anchor.toIndex} ` +
      `(root=${anchor.root.slice(0, 16)}..., OTS ${submitted}/${receipts.length})`
    );
    return { anchor, receipts };
  } finally {
    _running = false;
  }
}

/** 定期実行を開始する（多重 start は無視）。 */
function start() {
  if (_timer) return;
  _timer = setInterval(() => {
    runOnce().catch((e) => logger.warn(`anchor-scheduler: cycle failed: ${e.message}`));
  }, intervalMs());
  // テスト・CLI がタイマーで生き残らないように unref（invoice-poller と同じ扱い）
  if (_timer.unref) _timer.unref();
  logger.info(`anchor-scheduler: started (interval=${intervalMs()}ms, OTS=${otsClient.isEnabled() ? 'on' : 'off'})`);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { start, stop, runOnce, receiptPath, readReceipts, appendReceipts, DEFAULT_INTERVAL_MS };
