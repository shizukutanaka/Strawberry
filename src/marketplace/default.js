// src/marketplace/default.js
// 既定の marketplace-service シングルトン（JSON リポジトリ配線）。
// HTTP ルート等から `require('../../marketplace/default')` で利用する。
// 各サブサービスは repo を省略＝既定の JSON リポジトリを使用（読み込みは遅延）。
const { createEscrowService } = require('../payments/escrow-service');
const { createVerificationService } = require('../verification/verification-service');
const { createMarketplaceService } = require('./marketplace-service');
const { lightning } = require('../core/services');

const escrowService = createEscrowService({ lnAdapter: lightning });
const verificationService = createVerificationService();

module.exports = createMarketplaceService({ escrowService, verificationService });
