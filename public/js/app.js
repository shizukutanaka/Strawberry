// public/js/app.js — entry point: theme, nav, route table, router start.
import { route, setNotFound, start, navigate } from './router.js';
import { el, clear } from './ui.js';
import { getUser, isAuthenticated, clearSession } from './auth.js';
import * as loginPage from './pages/login.js';
import * as registerPage from './pages/register.js';
import * as notFoundPage from './pages/not-found.js';

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
    if (user && user.role === 'provider') {
      nav.appendChild(link('#/my-gpus', 'マイGPU'));
      nav.appendChild(link('#/gpus/new', 'GPU登録'));
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
setNotFound(notFoundPage.render);

// NOTE: '#/market' is the intended landing page but is added in increment 2;
// default to '#/login' until then.
start('#/login');
