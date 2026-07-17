// public/js/auth.js — session/token storage.
// Token kept in localStorage (survives reload). The app's strict CSP
// (script-src 'self' only, no inline scripts) is the primary XSS mitigation
// for this trade-off; there is no server-set httpOnly cookie session for the
// bearer JWT used by the JSON API.
const TOKEN_KEY = 'strawberry.token';
const USER_KEY = 'strawberry.user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
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

export function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function isAuthenticated() {
  return !!getToken();
}

export function isRole(role) {
  const user = getUser();
  return !!user && user.role === role;
}

// Shared login sequence: POST /users/login only returns {token, refreshToken}
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
  setSession(loginRes.token, null);
  const user = await api.me();
  setSession(loginRes.token, user);
  return user;
}
