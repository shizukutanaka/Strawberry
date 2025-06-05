// p2p-gpu.js - MVP用P2P GPUリスト公開・取得イベントの最小実装
const { createNode, signMessage, verifyMessage } = require('./p2p-node');
const fs = require('fs');
const path = require('path');

const GPUS_FILE = path.join(__dirname, 'gpus.json');

function saveGpus(gpus) {
  fs.writeFileSync(GPUS_FILE, JSON.stringify(gpus, null, 2));
}
function loadGpus() {
  if (!fs.existsSync(GPUS_FILE)) return [];
  return JSON.parse(fs.readFileSync(GPUS_FILE));
}

async function handleGpuEvent(msg) {
  if (!(await verifyMessage(msg))) return;
  const { payload } = msg;
  const gpus = loadGpus();
  if (!gpus.find(g => g.id === payload.id)) {
    gpus.push(payload);
    saveGpus(gpus);
    console.log('新規GPU情報を追加:', payload);
  }
}

async function broadcastGpu(node, peerId, gpu) {
  const msg = await signMessage(peerId, gpu);
  for (const peer of node.getPeers()) {
    node.sendToPeer(peer, 'gpu', msg);
  }
  handleGpuEvent(msg);
}

async function main() {
  const node = await createNode();
  node.on('gpu', handleGpuEvent);
  // CLI等からGPU情報登録/伝播を呼び出し可能に
}

if (require.main === module) main();

module.exports = {
  broadcastGpu,
  handleGpuEvent,
};
