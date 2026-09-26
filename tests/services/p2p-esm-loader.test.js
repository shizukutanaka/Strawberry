// §6(1): libp2p が ESM-only/未導入でも p2p-network.js が読み込め、
// services.js の p2pNetwork が従来通り null（503 経路）に留まることを確認。
const { P2PNetwork } = require('../../p2p-network');
const { p2pNetwork } = require('../../src/core/services');

describe('p2p ESM lazy loader (§6)', () => {
  it('module loads and exports a constructor even without libp2p', () => {
    expect(typeof P2PNetwork).toBe('function');
  });

  it('services.js keeps p2pNetwork null when libp2p is absent (503 preserved)', () => {
    // このリポジトリでは libp2p は package.json に無い → 無効化され 503 に留まる
    expect(p2pNetwork).toBeNull();
  });

  it('start() rejects cleanly when libp2p cannot be resolved', async () => {
    // jest VM は dynamic import を --experimental-vm-modules 無しで拒否するため、
    // 本番 Node（前掲の実検証で ERR_MODULE_NOT_FOUND）でも jest でも「静かに落ちない」
    // ことだけを確認する。
    const p = new P2PNetwork();
    await expect(p.start()).rejects.toThrow();
  });
});
