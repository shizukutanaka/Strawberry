// public/js/ui.js — DOM building helpers, toasts, formatters, status maps.
// el() builds elements via properties/attributes, never innerHTML with
// user-controlled data — this is the XSS-hygiene backbone of the whole SPA.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value; // only for trusted static strings
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list') {
      try { node[key] = value; } catch (_) { node.setAttribute(key, value); }
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

let toastSeq = 0;
export function toast(message, kind = 'info', timeoutMs = 4000) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const id = `toast-${++toastSeq}`;
  const node = el('div', { class: `toast toast-${kind}`, id }, message);
  container.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, timeoutMs);
}

export function skeleton(kind = 'card', count = 3) {
  const wrap = el('div', { class: kind === 'card' ? 'grid' : 'stack' });
  for (let i = 0; i < count; i++) {
    if (kind === 'card') {
      wrap.appendChild(el('div', { class: 'skeleton skeleton-card' }));
    } else {
      wrap.appendChild(el('div', { class: 'skeleton skeleton-line', style: `width:${60 + (i % 3) * 15}%` }));
    }
  }
  return wrap;
}

export function emptyState(icon, title, hint, cta) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'icon' }, icon),
    el('h3', {}, title),
    hint ? el('p', { class: 'muted' }, hint) : null,
    cta || null
  );
}

const STATUS_LABELS = {
  pending: '承認待ち',
  matched: '承認済み・決済待ち',
  active: '稼働中',
  completed: '完了',
  cancelled: 'キャンセル',
  disputed: '係争中',
};
const STATUS_ORDER = ['pending', 'matched', 'active', 'completed'];

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

export function statusBadge(status) {
  return el('span', { class: `badge badge-${status}` }, statusLabel(status));
}

export function timeline(order) {
  const current = order.status;
  const list = el('ul', { class: 'timeline' });
  const steps = STATUS_ORDER;
  const isTerminalAlt = current === 'cancelled' || current === 'disputed';
  const currentIdx = steps.indexOf(current);
  steps.forEach((step, idx) => {
    const li = el('li', {}, statusLabel(step));
    if (!isTerminalAlt && idx < currentIdx) li.classList.add('done');
    else if (!isTerminalAlt && idx === currentIdx) li.classList.add('current');
    list.appendChild(li);
  });
  if (isTerminalAlt) {
    list.appendChild(el('li', { class: 'current' }, statusLabel(current)));
  }
  return list;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtSats(n) {
  if (n == null || isNaN(n)) return '—';
  return `${Math.round(n).toLocaleString('ja-JP')} sats`;
}

export function fmtJpy(n) {
  if (n == null || isNaN(n)) return '—';
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}

export function fieldError(input, msg) {
  input.classList.toggle('invalid', !!msg);
  const wrap = input.closest('.field');
  if (!wrap) return;
  let node = wrap.querySelector('.error-msg');
  if (msg) {
    if (!node) {
      node = el('div', { class: 'error-msg' });
      wrap.appendChild(node);
    }
    node.textContent = msg;
  } else if (node) {
    node.remove();
  }
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' },
      el('h3', {}, '確認'),
      el('p', {}, message),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn btn-ghost', onClick: () => { backdrop.remove(); resolve(false); } }, 'キャンセル'),
        el('button', {
          class: 'btn btn-danger', onClick: () => { backdrop.remove(); resolve(true); },
        }, '実行'),
      )
    );
    backdrop.appendChild(modal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(false); } });
    document.body.appendChild(backdrop);
  });
}
