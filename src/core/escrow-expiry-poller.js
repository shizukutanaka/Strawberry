// src/core/escrow-expiry-poller.js
// deadlineAt 超過の PENDING エスクローを自動で DEADLINE→CANCELED へ遷移させる。
// 背景: escrow.create() は deadlineAt を保持し state-machine は PENDING+DEADLINE→CANCELED
// （cancel_invoice アクション）を定義済みだが、それを発火する経路が無く、未払いの
// hold invoice が期限後も PENDING のまま滞留し管理側資金がロックされたままだった。
// HELD はスイープ対象外 — 入金済みエスクローを機械的に DISPUTED へ倒すと
// 実行中ジョブの正当な決済を巻き込む。HELD の期限超過は係争フロー側で扱う。
// Design: single setInterval loop, re-entrant-safe（_running で重複実行抑止）。
const { logger } = require('../utils/logger');
const EscrowRepository = require('../db/json/EscrowRepository');
const { appendAuditLog } = require('../utils/audit-log');
const { createEscrowService } = require('../payments/escrow-service');

const POLL_INTERVAL_MS = 60_000; // 1 分粒度で十分（期限精度は分単位）

let _timer = null;
let _running = false;
let _escrowService = null;

function pollOnce() {
  if (!_escrowService || _running) return { expired: 0 };
  _running = true;
  let expired = 0;
  try {
    const now = Date.now();
    const overdue = (EscrowRepository.getAll() || []).filter(
      (e) => e.state === 'PENDING' && e.deadlineAt && Date.parse(e.deadlineAt) <= now
    );
    for (const escrow of overdue) {
      try {
        _escrowService.expire(escrow.id);
        expired += 1;
        appendAuditLog('escrow_deadline_expired', {
          escrowId: escrow.id,
          orderId: escrow.orderId,
          deadlineAt: escrow.deadlineAt,
        });
        logger.info(`Escrow expired by deadline sweep: escrowId=${escrow.id} orderId=${escrow.orderId}`);
      } catch (e) {
        // 個別失敗は畳み込み、他のエスクローのスイープを止めない
        logger.warn(`escrow-expiry-poller: expire failed for ${escrow.id}: ${e.message}`);
      }
    }
    return { expired };
  } finally {
    _running = false;
  }
}

function start() {
  // 冪等: 二重 start でタイマーを増殖させない
  if (_timer) return;
  if (!_escrowService) {
    _escrowService = createEscrowService({ repository: EscrowRepository });
  }
  // テスト環境ではタイマーを張らない（open handle 防止）。
  // pollOnce() は直接叩けるためテストは start() 後も挙動を確認できる。
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return;
  _timer = setInterval(() => {
    try { pollOnce(); } catch (e) { logger.warn(`escrow-expiry-poller: poll failed: ${e.message}`); }
  }, POLL_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  logger.info('escrow-expiry-poller started (interval=60s)');
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, pollOnce };
