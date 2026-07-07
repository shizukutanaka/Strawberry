// public/js/router.js — minimal hash router.
// Each route's render(container, params) may return a cleanup function; it is
// called before the next route renders. This contract matters: pages that set
// up setInterval polling (order-detail's payment/heartbeat tickers) MUST return
// a cleanup that clears them, or navigating away leaks timers.
import { isAuthenticated, isRole } from './auth.js';

const routes = [];
let currentCleanup = null;
let notFoundRender = (container) => { container.textContent = 'ページが見つかりません'; };

export function route(pattern, { render, auth = false, roles = null }) {
  // pattern: '#/orders/:id' -> { regex, keys }
  const keys = [];
  const regexStr = pattern
    .replace(/^#\//, '')
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const regex = new RegExp(`^${regexStr}$`);
  routes.push({ regex, keys, render, auth, roles });
}

export function setNotFound(render) {
  notFoundRender = render;
}

function parseHash() {
  const hash = location.hash || '#/';
  const [pathPart, queryPart] = hash.slice(1).split('?');
  const path = pathPart.replace(/^\//, '').replace(/\/$/, '');
  const query = new URLSearchParams(queryPart || '');
  return { path, query };
}

async function renderCurrent() {
  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch (_) { /* ignore cleanup errors */ }
    currentCleanup = null;
  }
  const { path, query } = parseHash();
  const container = document.getElementById('app');

  for (const r of routes) {
    const m = path.match(r.regex);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

    if (r.auth && !isAuthenticated()) {
      navigate(`#/login?next=${encodeURIComponent(location.hash.slice(1))}`);
      return;
    }
    if (r.roles && !r.roles.some((role) => isRole(role))) {
      container.innerHTML = '';
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = '<div class="icon">🚫</div><h3>アクセス権限がありません</h3>';
      container.appendChild(div);
      return;
    }

    container.innerHTML = '';
    try {
      const cleanup = await r.render(container, params, query);
      if (typeof cleanup === 'function') currentCleanup = cleanup;
    } catch (err) {
      console.error('[router] render failed:', err);
      container.innerHTML = '';
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `<div class="icon">⚠️</div><h3>画面の表示に失敗しました</h3><p class="muted">${escapeText(err.message || String(err))}</p>`;
      container.appendChild(div);
    }
    window.dispatchEvent(new CustomEvent('strawberry:navigated', { detail: { path } }));
    return;
  }

  container.innerHTML = '';
  notFoundRender(container);
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export function navigate(hash) {
  if (location.hash === hash) {
    renderCurrent();
  } else {
    location.hash = hash;
  }
}

export function start(defaultHash = '#/market') {
  window.addEventListener('hashchange', renderCurrent);
  if (!location.hash) location.hash = defaultHash;
  renderCurrent();
}
