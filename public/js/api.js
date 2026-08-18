// public/js/api.js — fetch wrapper + typed endpoint helpers.
import { getToken, clearSession } from './auth.js';

export class ApiError extends Error {
  constructor(message, status, type) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
  }
}

async function request(path, { method = 'GET', body, auth = true, query } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let url = path;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    if (qs) url += `?${qs}`;
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    throw new ApiError('サーバーに接続できませんでした。ネットワーク状態を確認してください。', 0, 'NETWORK_ERROR');
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = null; }
  }

  if (res.status === 401 && auth) {
    clearSession();
    const next = encodeURIComponent(location.hash.slice(1) || '/market');
    if (!location.hash.startsWith('#/login')) {
      location.hash = `#/login?next=${next}`;
    }
  }

  if (!res.ok) {
    const errObj = data && data.error;
    const message = (errObj && (errObj.message || errObj)) || (data && data.message) || `リクエストに失敗しました (${res.status})`;
    const type = (errObj && errObj.type) || null;
    throw new ApiError(typeof message === 'string' ? message : JSON.stringify(message), res.status, type);
  }

  return data;
}

export const api = {
  // --- auth ---
  register: (username, email, password, role) =>
    request('/api/v1/users/register', { method: 'POST', auth: false, body: { username, email, password, ...(role ? { role } : {}) } }),
  login: (email, password) =>
    request('/api/v1/users/login', { method: 'POST', auth: false, body: { email, password } }),
  me: () => request('/api/v1/users/me'),

  // --- gpus ---
  listGpus: (filters) => request('/api/v1/gpus', { query: filters, auth: false }),
  getGpu: (id) => request(`/api/v1/gpus/${id}`, { auth: false }),
  getGpuReviews: (id, query) => request(`/api/v1/gpus/${id}/reviews`, { auth: false, query }),
  getGpuMarketRate: (id) => request(`/api/v1/gpus/${id}/market-rate`, { auth: false }),
  getGpuWatch: (id) => request(`/api/v1/gpus/${id}/watch`),
  setGpuWatch: (id, targetPrice) => request(`/api/v1/gpus/${id}/watch`, { method: 'POST', body: { targetPrice } }),
  removeGpuWatch: (id) => request(`/api/v1/gpus/${id}/watch`, { method: 'DELETE' }),
  myGpus: (query) => request('/api/v1/gpus/my', { query }),
  createGpu: (payload) => request('/api/v1/gpus', { method: 'POST', body: payload }),
  updateGpu: (id, updates) => request(`/api/v1/gpus/${id}`, { method: 'PUT', body: updates }),

  // --- orders ---
  listOrders: (query) => request('/api/v1/orders', { query }),
  orderStats: () => request('/api/v1/orders/stats'),
  providerEarnings: (query) => request('/api/v1/orders/provider/earnings', { query }),
  getOrder: (id) => request(`/api/v1/orders/${id}`),
  getOrderPayment: (id) => request(`/api/v1/orders/${id}/payment`),
  // tier: 'ondemand'(既定) | 'spot'（中断許容・割引。出品側が spotEnabled の GPU のみ）
  createOrder: (gpuId, durationMinutes, tier) => request('/api/v1/orders', {
    method: 'POST',
    body: tier && tier !== 'ondemand' ? { gpuId, durationMinutes, tier } : { gpuId, durationMinutes },
  }),
  preemptOrder: (orderId) => request(`/api/v1/orders/${orderId}/preempt`, { method: 'POST' }),
  // GPU アクセスの受け渡し（プロバイダが投入 / 借り手が受け取る）
  deliverAccess: (orderId, body) => request(`/api/v1/orders/${orderId}/access`, { method: 'POST', body }),
  getAccess: (orderId) => request(`/api/v1/orders/${orderId}/access`),
  acceptOrder: (id) => request(`/api/v1/orders/${id}/accept`, { method: 'POST' }),
  rejectOrder: (id) => request(`/api/v1/orders/${id}/reject`, { method: 'POST' }),
  startOrder: (id) => request(`/api/v1/orders/${id}/start`, { method: 'POST' }),
  stopOrder: (id) => request(`/api/v1/orders/${id}/stop`, { method: 'POST' }),
  heartbeat: (id, role) => request(`/api/v1/orders/${id}/heartbeat`, { method: 'POST', body: { role } }),
  reviewOrder: (id, rating, comment) => request(`/api/v1/orders/${id}/review`, { method: 'POST', body: { rating, comment } }),
  raiseDispute: (id, reason) => request(`/api/v1/orders/${id}/dispute`, { method: 'POST', body: { reason } }),
  resolveDispute: (id, decision, note) => request(`/api/v1/orders/${id}/dispute/resolve`, { method: 'POST', body: { decision, note } }),

  // --- payments ---
  createPayment: (orderId, paymentMethod) => request(`/api/v1/payments/order/${orderId}`, { method: 'POST', body: { paymentMethod } }),
  paymentStatus: (paymentId) => request(`/api/v1/payments/${paymentId}/status`),
  approveManualPayment: (paymentId) => request(`/api/v1/payments/manual/approve/${paymentId}`, { method: 'POST' }),
  pendingManualPayments: () => request('/api/v1/payments/admin/pending'),

  // --- 収益台帳・出金 ---
  // providerEarnings（注文の総額集計）と違い、こちらは**実際に受け取れる残高**。
  ledger: (query) => request('/api/v1/payments/earnings', { query }),
  requestPayout: (amountSats) => request('/api/v1/payments/payouts', { method: 'POST', body: { amountSats } }),
  myPayouts: () => request('/api/v1/payments/payouts'),
  pendingPayouts: () => request('/api/v1/payments/admin/payouts'),
  reconciliation: () => request('/api/v1/payments/admin/reconciliation'),
  completePayout: (id, txid) => request(`/api/v1/payments/admin/payouts/${id}/complete`, { method: 'POST', body: { txid } }),
  rejectPayout: (id, reason) => request(`/api/v1/payments/admin/payouts/${id}/reject`, { method: 'POST', body: { reason } }),

  // --- exchange rate ---
  exchangeRate: (fresh) => request('/api/exchange-rate', { auth: false, query: fresh ? { fresh: 'true' } : undefined }),
};
