// public/js/api.js — fetch wrapper + typed endpoint helpers.
import { getToken, getRefreshToken, getUser, setSession, clearSession } from './auth.js';

export class ApiError extends Error {
  constructor(message, status, type) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
  }
}

// アクセストークン期限切れ（401）時のリフレッシュ。
// refresh token はサーバ側でローテーションされるため、並行リクエストが各自で
// /refresh を叩くと2回目が「再利用検知」となり全セッションが失効する。
// そのため実行中の refresh をモジュールスコープで直列化（deduplicate）する。
let _refreshInFlight = null;
function tryRefreshSession() {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetch('/api/v1/users/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      if (!data || typeof data.token !== 'string') return false;
      // ローテーション後の新 refreshToken も保存（古いものはサーバで失効済み）
      setSession(data.token, getUser(), data.refreshToken);
      return true;
    } catch (_) {
      return false;
    }
  })().finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}

async function request(path, { method = 'GET', body, auth = true, query, _retried = false } = {}) {
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
    // まず refresh token でセッション更新を試みる（アクセストークン TTL 1h
    // 切れのたびに強制再ログインさせない）。更新に成功したら元リクエストを
    // 1 度だけ再試行する。失敗（refresh 失効・未保持）のみ従来通り
    // セッションを破棄してログインへ遷移する。
    if (!_retried && await tryRefreshSession()) {
      return request(path, { method, body, auth, query, _retried: true });
    }
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
  createOrder: (gpuId, durationMinutes) => request('/api/v1/orders', { method: 'POST', body: { gpuId, durationMinutes } }),
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

  // --- exchange rate ---
  exchangeRate: (fresh) => request('/api/exchange-rate', { auth: false, query: fresh ? { fresh: 'true' } : undefined }),
};
