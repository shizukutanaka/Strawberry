// src/api/routes/order/escrow.js - order ルート群で共有するエスクローサービス。
// lnAdapter は初回呼出し時に捕捉する（ルート require 時点では lightning が
// 未初期化の場合があるため、ハンドラ実行時まで生成を遅延する）。
const { createEscrowService } = require('../../../payments/escrow-service');
const { lightning } = require('../../../core/services');

let _svc = null;

function escrowService() {
  if (!_svc) _svc = createEscrowService({ lnAdapter: lightning });
  return _svc;
}

module.exports = { escrowService };
