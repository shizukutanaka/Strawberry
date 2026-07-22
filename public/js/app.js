// public/js/app.js — entry point: theme, nav, route table, router start.
import { route, setNotFound, start, navigate } from './router.js';
import { el, clear } from './ui.js';
import { getUser, isAuthenticated, clearSession } from './auth.js';
import * as loginPage from './pages/login.js';
import * as registerPage from './pages/register.js';
import * as notFoundPage from './pages/not-found.js';
import * as marketPage from './pages/market.js';
import * as gpuNewPage from './pages/gpu-new.js';
import * as myGpusPage from './pages/my-gpus.js';
import * as ordersPage from './pages/orders.js';
import * as orderDetailPage from './pages/order-detail.js';
import * as adminPaymentsPage from './pages/admin-payments.js';
import * as earningsPage from './pages/earnings.js';
import * as gpuDetailPage from './pages/gpu-detail.js';
import * as watchesPage from './pages/watches.js';

// ---------- Theme ----------
const THEME_KEY = 'strawberry.theme';
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || '');
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved || '');
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effectiveCurrent = current || (prefersDark ? 'dark' : 'light');
  const next = effectiveCurrent === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}
initTheme();
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

// ---------- Nav / auth actions ----------
function renderNav() {
  const nav = document.getElementById('nav');
  const authActions = document.getElementById('auth-actions');
  clear(nav);
  clear(authActions);

  const user = getUser();
  const currentPath = (location.hash || '#/').split('?')[0];
  const link = (href, label) => {
    const a = el('a', { href }, label);
    if (currentPath === href || (href !== '#/' && currentPath.startsWith(href))) a.classList.add('active');
    return a;
  };

  nav.appendChild(link('#/market', 'マーケット'));
  if (isAuthenticated()) {
    nav.appendChild(link('#/orders', '注文'));
    nav.appendChild(link('#/watches', 'ウォッチ'));
    if (user && user.role === 'provider') {
      nav.appendChild(link('#/my-gpus', 'マイGPU'));
      nav.appendChild(link('#/gpus/new', 'GPU登録'));
      nav.appendChild(link('#/earnings', '収益'));
    }
    if (user && user.role === 'admin') {
      nav.appendChild(link('#/admin/payments', '決済承認'));
    }
  }

  if (isAuthenticated()) {
    authActions.appendChild(el('span', { class: 'muted', style: 'margin-right:8px' }, user ? user.username : ''));
    authActions.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      onClick: () => { clearSession(); navigate('#/login'); },
    }, 'ログアウト'));
  } else {
    authActions.appendChild(el('a', { href: '#/login', class: 'btn btn-ghost btn-sm' }, 'ログイン'));
    authActions.appendChild(el('a', { href: '#/register', class: 'btn btn-primary btn-sm', style: 'margin-left:8px' }, '新規登録'));
  }
}
window.addEventListener('strawberry:navigated', renderNav);
window.addEventListener('hashchange', renderNav);
renderNav();

// ---------- Routes ----------
route('#/login', { render: loginPage.render });
route('#/register', { render: registerPage.render });
route('#/market', { render: marketPage.render });
route('#/gpus/new', { render: gpuNewPage.render, auth: true, roles: ['provider', 'admin'] });
route('#/gpus/:id', { render: gpuDetailPage.render });
route('#/my-gpus', { render: myGpusPage.render, auth: true, roles: ['provider', 'admin'] });
route('#/orders', { render: ordersPage.render, auth: true });
route('#/orders/:id', { render: orderDetailPage.render, auth: true });
route('#/admin/payments', { render: adminPaymentsPage.render, auth: true, roles: ['admin'] });
route('#/earnings', { render: earningsPage.render, auth: true, roles: ['provider', 'admin'] });
route('#/watches', { render: watchesPage.render, auth: true });
setNotFound(notFoundPage.render);

start('#/market');
