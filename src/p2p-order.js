// p2p-order.js - MVP用P2P注文・マッチング・支払いイベント伝播の最小実装
const { createNode, signMessage, verifyMessage } = require('./p2p-node');
const fs = require('fs');
const path = require('path');

const ORDERS_FILE = path.join(__dirname, 'orders.json');
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');

// ローカル保存
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}
function loadOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(ORDERS_FILE));
}
function savePayments(payments) {
  fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(payments, null, 2));
}
function loadPayments() {
  if (!fs.existsSync(PAYMENTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PAYMENTS_FILE));
}

// P2Pイベントハンドラ
async function handleOrderEvent(msg) {
  if (!(await verifyMessage(msg))) return;
  const { payload } = msg;
  const orders = loadOrders();
  if (!orders.find(o => o.id === payload.id)) {
    orders.push(payload);
    saveOrders(orders);
    console.log('新規注文を追加:', payload);
  }
}
async function handlePaymentEvent(msg) {
  if (!(await verifyMessage(msg))) return;
  const { payload } = msg;
  const payments = loadPayments();
  if (!payments.find(p => p.id === payload.id)) {
    payments.push(payload);
    savePayments(payments);
    console.log('新規支払いを追加:', payload);
  }
}

// MVP用: 注文をP2Pネットワークに伝播
async function broadcastOrder(node, peerId, order) {
  const msg = await signMessage(peerId, order);
  for (const peer of node.getPeers()) {
    node.sendToPeer(peer, 'order', msg);
  }
  handleOrderEvent(msg); // 自分にも反映
}
// MVP用: 支払いをP2Pネットワークに伝播
async function broadcastPayment(node, peerId, payment) {
  const msg = await signMessage(peerId, payment);
  for (const peer of node.getPeers()) {
    node.sendToPeer(peer, 'payment', msg);
  }
  handlePaymentEvent(msg);
}

// ノード起動・イベント登録例
async function main() {
  const node = await createNode();
  node.on('order', handleOrderEvent);
  node.on('payment', handlePaymentEvent);
  // CLI等から注文・支払い作成/伝播を呼び出し可能に
}

if (require.main === module) main();

module.exports = {
  broadcastOrder,
  broadcastPayment,
  handleOrderEvent,
  handlePaymentEvent,
};
