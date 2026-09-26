// p2p-health.js - MVP用P2Pノードの死活監視・異常検知の最小実装
const { createNode } = require('./p2p-node');
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('./db/json/atomicWrite');

// 実行時生成物は src/ 配下に置かない（非 root コンテナでは src/ が読み取り専用）。
const HEALTH_FILE = process.env.P2P_HEALTH_FILE
  || path.join(__dirname, '../data/health.json');

function saveHealth(health) {
  atomicWriteJSON(HEALTH_FILE, health);
}
function loadHealth() {
  if (!fs.existsSync(HEALTH_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(HEALTH_FILE)); } catch (_) { return {}; }
}

async function main() {
  const node = await createNode();
  setInterval(() => {
    const peers = node.getPeers ? node.getPeers() : [];
    const health = {
      timestamp: Date.now(),
      peerId: node.peerId.toString(),
      peerCount: peers.length,
      peers,
    };
    saveHealth(health);
    console.log('ノード死活監視:', health);
    // 異常検知例: ピア数が0なら警告
    if (peers.length === 0) {
      console.warn('警告: ピア接続なし（ネットワーク分断の可能性）');
    }
  }, 10000); // 10秒ごとに死活監視
}

if (require.main === module) main();

module.exports = {
  main
};
