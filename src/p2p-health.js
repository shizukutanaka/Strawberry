// p2p-health.js - MVP用P2Pノードの死活監視・異常検知の最小実装
const { createNode } = require('./p2p-node');
const fs = require('fs');
const path = require('path');

const HEALTH_FILE = path.join(__dirname, 'health.json');

function saveHealth(health) {
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2));
}
function loadHealth() {
  if (!fs.existsSync(HEALTH_FILE)) return {};
  return JSON.parse(fs.readFileSync(HEALTH_FILE));
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
