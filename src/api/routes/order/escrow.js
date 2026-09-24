// src/api/routes/order/escrow.js - order ルート群で共有するエスクローサービス。
// lnAdapter は初回呼出し時に捕捉する（ルート require 時点では lightning が
// 未初期化の場合があるため、ハンドラ実行時まで生成を遅延する）。
const { createEscrowService } = require('../../../payments/escrow-service');
const { lightning } = require('../../../core/services');
const { logger } = require('../../../utils/logger');
const EscrowRepository = require('../../../db/json/EscrowRepository');

let _svc = null;

function escrowService() {
  if (!_svc) _svc = createEscrowService({ lnAdapter: lightning });
  return _svc;
}

// 注文に紐づく未終了エスクロー（CANCELED/SETTLED 以外）を全てベストエフォートで
// キャンセルする。ルックアップ失敗・個別失敗は warn 記録のみで処理を続行する。
// context はログ識別用の操作名（例: 'order reject'）。
function cancelEscrowsForOrder(orderId, context) {
  try {
    const escrows = EscrowRepository.getByOrderId(orderId);
    if (!Array.isArray(escrows) || escrows.length === 0) return;
    const svc = escrowService();
    for (const escrow of escrows) {
      if (['CANCELED', 'SETTLED'].includes(escrow.state)) continue;
      try { svc.cancel(escrow.id); } catch (e) {
        logger.warn(`Escrow cancel failed on ${context} (id=${escrow.id}): ${e.message}`);
      }
    }
  } catch (e) {
    logger.warn(`Escrow lookup on ${context} failed (order=${orderId}): ${e.message}`);
  }
}

module.exports = { escrowService, cancelEscrowsForOrder };
