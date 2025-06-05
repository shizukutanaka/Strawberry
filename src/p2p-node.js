// p2p-node.js - P2Pノードの最小構成（libp2p + Ed25519署名 + 暗号化）
const Libp2p = require('libp2p');
const { Noise } = require('@chainsafe/libp2p-noise');
const { TCP } = require('@libp2p/tcp');
const { Mplex } = require('@libp2p/mplex');
const { createEd25519PeerId } = require('@libp2p/peer-id-factory');
const crypto = require('crypto');

// 署名付きメッセージ生成
async function signMessage(peerId, payload) {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = { payload, timestamp, nonce };
  const data = Buffer.from(JSON.stringify(message));
  const signature = await peerId.privKey.sign(data);
  return { ...message, signature: signature.toString('base64'), peerId: peerId.toString() };
}

// 署名検証
async function verifyMessage(msg) {
  const { payload, timestamp, nonce, signature, peerId } = msg;
  const data = Buffer.from(JSON.stringify({ payload, timestamp, nonce }));
  // PeerId復元
  const peerIdFactory = require('peer-id');
  const peerIdObj = await peerIdFactory.createFromB58String(peerId);
  return peerIdObj.pubKey.verify(data, Buffer.from(signature, 'base64'));
}

async function createNode() {
  const peerId = await createEd25519PeerId();
  const node = await Libp2p.create({
    peerId,
    addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
    transports: [new TCP()],
    streamMuxers: [new Mplex()],
    connectionEncryption: [new Noise()]
  });
  await node.start();
  console.log(`P2Pノード起動: ${peerId.toString()}`);
  return node;
}

module.exports = {
  createNode,
  signMessage,
  verifyMessage
};
