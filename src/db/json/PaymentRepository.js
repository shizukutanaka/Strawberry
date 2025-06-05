// ファイルベースJSONストレージによる決済リポジトリ
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const PAYMENTS_PATH = path.resolve(__dirname, '../../../data/payments.json');

function loadPayments() {
  if (!fs.existsSync(PAYMENTS_PATH)) return [];
  const raw = fs.readFileSync(PAYMENTS_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function savePayments(payments) {
  fs.writeFileSync(PAYMENTS_PATH, JSON.stringify(payments, null, 2), 'utf-8');
}

module.exports = {
  getAll: () => loadPayments(),
  getById: (id) => loadPayments().find(p => p.id === id),
  getByOrderId: (orderId) => loadPayments().filter(p => p.orderId === orderId),
  getByUserId: (userId) => loadPayments().filter(p => p.userId === userId),
  create: (payment) => {
    const payments = loadPayments();
    const newPayment = { ...payment, id: uuidv4(), createdAt: new Date().toISOString() };
    payments.push(newPayment);
    savePayments(payments);
    return newPayment;
  },
  update: (id, updates) => {
    const payments = loadPayments();
    const idx = payments.findIndex(p => p.id === id);
    if (idx === -1) return null;
    payments[idx] = { ...payments[idx], ...updates };
    savePayments(payments);
    return payments[idx];
  },
  delete: (id) => {
    let payments = loadPayments();
    const prevLen = payments.length;
    payments = payments.filter(p => p.id !== id);
    savePayments(payments);
    return payments.length < prevLen;
  }
};
