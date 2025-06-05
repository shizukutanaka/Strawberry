// ファイルベースJSONストレージによる注文リポジトリ
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const ORDERS_PATH = path.resolve(__dirname, '../../../data/orders.json');

function loadOrders() {
  if (!fs.existsSync(ORDERS_PATH)) return [];
  const raw = fs.readFileSync(ORDERS_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2), 'utf-8');
}

module.exports = {
  getAll: () => loadOrders(),
  getById: (id) => loadOrders().find(o => o.id === id),
  getByUserId: (userId) => loadOrders().filter(o => o.userId === userId),
  create: (order) => {
    const orders = loadOrders();
    const newOrder = { ...order, id: uuidv4(), createdAt: new Date().toISOString() };
    orders.push(newOrder);
    saveOrders(orders);
    return newOrder;
  },
  update: (id, updates) => {
    const orders = loadOrders();
    const idx = orders.findIndex(o => o.id === id);
    if (idx === -1) return null;
    orders[idx] = { ...orders[idx], ...updates };
    saveOrders(orders);
    return orders[idx];
  },
  delete: (id) => {
    let orders = loadOrders();
    const prevLen = orders.length;
    orders = orders.filter(o => o.id !== id);
    saveOrders(orders);
    return orders.length < prevLen;
  }
};
