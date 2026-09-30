// p2p-node.js - P2Pノードの最小構成（libp2p + Ed25519署名 + 暗号化）
// libp2p 系は optionalDependencies 相当（package.json 未収録）。トップレベルで
// require すると、このファイルを間接参照するだけのモジュール（p2p-notify 等）まで
// MODULE_NOT_FOUND で道連れにするため、実際にノードを起動する createNode() 内で
// 遅延 require し、未導入時は手順付きエラーにする。
const crypto = require('crypto');

const P2P_DEP_HINT = 'P2P 機能には libp2p 系パッケージが必要です: npm i libp2p @chainsafe/libp2p-noise @libp2p/tcp @libp2p/mplex @libp2p/peer-id-factory peer-id';

function requireP2PDeps() {
  try {
    return {
      Libp2p: require('libp2p'),
      Noise: require('@chainsafe/libp2p-noise').Noise,
      TCP: require('@libp2p/tcp').TCP,
      Mplex: require('@libp2p/mplex').Mplex,
      createEd25519PeerId: require('@libp2p/peer-id-factory').createEd25519PeerId,
    };
  } catch (e) {
    throw new Error(`${P2P_DEP_HINT} (原因: ${e.message})`);
  }
}

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
  let peerIdFactory;
  try {
    peerIdFactory = require('peer-id');
  } catch (e) {
    throw new Error(`${P2P_DEP_HINT} (原因: ${e.message})`);
  }
  const peerIdObj = await peerIdFactory.createFromB58String(peerId);
  return peerIdObj.pubKey.verify(data, Buffer.from(signature, 'base64'));
}

async function createNode() {
  const { Libp2p, Noise, TCP, Mplex, createEd25519PeerId } = requireP2PDeps();
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
