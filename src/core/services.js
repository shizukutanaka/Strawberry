// src/core/services.js - インフラ系コアサービスのシングルトン提供（ガード付き）
//
// virtual-gpu-manager(dockerode/k8s) はネイティブ依存であり、未導入や
// 読込失敗が起こり得る。それをモジュール読込時に new するとサーバ全体が
// 起動不能になるため、ここで安全に読み込み、失敗時は null（無効化モード）に
// フォールバックする。これにより JSON データ層で動く Web API 本体は常に起動できる。
// （Lightning 決済サービスは金銭機能の廃止に伴い 2026-11-16 に除去済み。）
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

module.exports = { gpuDetector, vgpuManager, requireService };
