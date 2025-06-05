// cli.js - MVP用P2Pマーケットプレイス操作CLI（注文・支払い・GPU情報の発行・伝播）
const { createNode } = require('./p2p-node');
const { broadcastOrder } = require('./p2p-order');
const { broadcastPayment } = require('./p2p-order');
const { broadcastGpu } = require('./p2p-gpu');
const readline = require('readline');

async function main() {
  const node = await createNode();
  console.log('コマンド例: order/gpu/payment/exit');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on('line', async (line) => {
    const [cmd, ...args] = line.trim().split(' ');
    if (cmd === 'order') {
      // order <orderId> <gpuId> <amount>
      const [orderId, gpuId, amount] = args;
      const order = { id: orderId, gpuId, amount: parseInt(amount), created: Date.now() };
      await broadcastOrder(node, node.peerId, order);
      console.log('注文を送信:', order);
    } else if (cmd === 'gpu') {
      // gpu <gpuId> <model> <price>
      const [gpuId, model, price] = args;
      const gpu = { id: gpuId, model, price: parseInt(price), created: Date.now() };
      await broadcastGpu(node, node.peerId, gpu);
      console.log('GPU情報を送信:', gpu);
    } else if (cmd === 'payment') {
      // payment <paymentId> <orderId> <amount>
      const [paymentId, orderId, amount] = args;
      const payment = { id: paymentId, orderId, amount: parseInt(amount), created: Date.now() };
      await broadcastPayment(node, node.peerId, payment);
      console.log('支払い情報を送信:', payment);
    } else if (cmd === 'exit') {
      rl.close();
      process.exit(0);
    } else {
      console.log('コマンド例: order/gpu/payment/exit');
    }
  });
}

if (require.main === module) main();
