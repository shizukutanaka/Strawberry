// public/js/pages/orders.js — the current user's orders (as renter and/or provider).
import { el, skeleton, emptyState, statusBadge, fmtDate, fmtSats } from '../ui.js';
import { api, ApiError } from '../api.js';
import { navigate } from '../router.js';

export async function render(container) {
  const listWrap = el('div', { class: 'table-wrap' }, skeleton('line', 5));
  container.appendChild(
    el('div', { class: 'stack' },
      el('h1', {}, '注文一覧'),
      listWrap,
    )
  );

  try {
    const res = await api.listOrders({ limit: 100 });
    if (!res.orders.length) {
      listWrap.replaceChildren(
        emptyState('📦', 'まだ注文がありません', 'マーケットからGPUを探してみましょう。',
          el('a', { href: '#/market', class: 'btn btn-primary' }, 'マーケットへ'))
      );
      return;
    }
    const table = el('table', { class: 'data-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'ステータス'), el('th', {}, '価格'), el('th', {}, '時間'), el('th', {}, '作成日'))),
      el('tbody', {}, ...res.orders.map((order) => {
        const row = el('tr', {
          onClick: () => navigate(`#/orders/${order.id}`),
        },
          el('td', { 'data-label': 'ステータス' }, statusBadge(order.status)),
          el('td', { 'data-label': '価格' }, fmtSats(order.totalPrice)),
          el('td', { 'data-label': '時間' }, `${order.durationMinutes}分`),
          el('td', { 'data-label': '作成日' }, fmtDate(order.createdAt)),
        );
        return row;
      })),
    );
    listWrap.replaceChildren(table);
  } catch (err) {
    listWrap.replaceChildren(emptyState('⚠️', '取得に失敗しました', err instanceof ApiError ? err.message : ''));
  }
}
