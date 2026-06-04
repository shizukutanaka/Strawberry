// src/core/services.js - インフラ系コアサービスのシングルトン提供（ガード付き）
//
// virtual-gpu-manager(dockerode/k8s)・p2p-network(libp2p, ESM)・
// lightning-service(gRPC) はネイティブ/ESM依存であり、未導入や読込失敗が起こり得る。
// それらをモジュール読込時に new するとサーバ全体が起動不能になるため、
// ここで一括して安全に読み込み、失敗時は null（無効化モード）にフォールバックする。
// これにより JSON データ層で動く Web API 本体は常に起動できる。
const { logger } = require('../utils/logger');

function safeLoad(label, loader) {
  try {
    const Klass = loader();
    if (typeof Klass !== 'function') {
      logger.warn(`Optional service "${label}" did not export a constructor; disabled.`);
      return null;
    }
    return new Klass();
  } catch (e) {
    logger.warn(`Optional service "${label}" unavailable; related endpoints disabled: ${e.message}`);
    return null;
  }
}

const gpuDetector = safeLoad('gpu-detector-extended', () => require('./gpu-detector-extended').ExtendedGPUDetector);
const vgpuManager = safeLoad('virtual-gpu-manager', () => require('../../virtual-gpu-manager').VirtualGPUManager);
const p2pNetwork = safeLoad('p2p-network', () => require('../../p2p-network').P2PNetwork);
const lightning = safeLoad('lightning-service', () => require('../../lightning-service').LightningService);

/**
 * サービスが無効（null）の場合に 503 を返すヘルパ。
 * @returns {boolean} 利用可能なら true、503返却済みなら false
 */
function requireService(svc, res) {
  if (!svc) {
    res.status(503).json({ error: 'Service unavailable (optional dependency not installed or failed to load)' });
    return false;
  }
  return true;
}

module.exports = { gpuDetector, vgpuManager, p2pNetwork, lightning, requireService };
