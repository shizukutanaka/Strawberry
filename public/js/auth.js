// public/js/auth.js — session/token storage.
// Token kept in localStorage (survives reload). The app's strict CSP
// (script-src 'self' only, no inline scripts) is the primary XSS mitigation
// for this trade-off; there is no server-set httpOnly cookie session for the
// bearer JWT used by the JSON API.
const TOKEN_KEY = 'strawberry.token';
const REFRESH_KEY = 'strawberry.refresh';
const USER_KEY = 'strawberry.user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

// Long-lived refresh token (7d by default, server-side). The access token is
// short-lived (1h); without this the product logged everyone out mid-rental
// every hour, because api.js's 401 handler had nothing to refresh with.
export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}

export function getUser() {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// refreshToken is optional so callers that only re-fetch the user record
// (GET /users/me after login) don't clobber the refresh token.
export function setSession(token, user, refreshToken) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

// Logout = tell the server first, then forget locally. Clearing localStorage
// alone leaves the bearer token valid until it expires (up to 1h) and the
// refresh token valid for days; POST /users/logout puts both on the server's
// denylist so a copied token is dead the moment the user clicks ログアウト.
// The server call is best-effort: a network failure must not trap the user
// in a logged-in state.
export async function logout() {
  const refreshToken = getRefreshToken();
  try {
    const { api } = await import('./api.js');
    await api.logout(refreshToken);
  } catch (_) { /* offline or already invalid: local logout still proceeds */ }
  clearSession();
}

export function isAuthenticated() {
  return !!getToken();
}

export function isRole(role) {
  const user = getUser();
  return !!user && user.role === role;
}

// Shared login sequence: POST /users/login returns {token, refreshToken}
// (no user object), so a follow-up GET /users/me is required to get
// {id, username, role, ...} for nav/role-gating. Both login.js and
// register.js (which auto-logs-in after registering) need this exact
// sequence — centralized here so it's fixed in one place if it changes.
export async function performLogin(email, password) {
  // Deferred import avoids a circular dependency (api.js doesn't import auth
  // functions that would need auth.js at module-eval time; only this function,
  // called at runtime, needs api.js).
  const { api } = await import('./api.js');
  const loginRes = await api.login(email, password);
  setSession(loginRes.token, null, loginRes.refreshToken);
  const user = await api.me();
  setSession(loginRes.token, user);
  return user;
}
