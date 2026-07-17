// public/js/pages/orders.js — the current user's orders (as renter and/or provider),
// with a stats summary header (GET /orders/stats — available to every user,
// not just providers; previously had zero frontend reach).
import { el, skeleton, emptyState, statusBadge, fmtDate, fmtSats, fmtJpy } from '../ui.js';
import { api, ApiError } from '../api.js';
import { navigate } from '../router.js';

const STATUS_LABELS = {
  pending: '承認待ち', matched: '承認済み', active: '稼働中',
  completed: '完了', cancelled: 'キャンセル', disputed: '係争中',
};

function statusBreakdown(byStatus) {
  const parts = Object.entries(byStatus).map(([status, count]) => `${STATUS_LABELS[status] || status} ${count}件`);
  return parts.length ? parts.join(' / ') : '注文なし';
}

function statsHeader(stats) {
  const cards = [
    el('div', { class: 'card' },
      el('div', { class: 'muted', style: 'font-size:0.8rem' }, '借り手として'),
      el('div', { style: 'font-size:1.2rem;font-weight:700' }, `${stats.asRenter.total}件`),
      el('div', { class: 'muted', style: 'font-size:0.8rem' }, statusBreakdown(stats.asRenter.byStatus)),
      stats.asRenter.totalSpentSats > 0
        ? el('div', { style: 'margin-top:4px' }, `支出合計: ${fmtSats(stats.asRenter.totalSpentSats)}（約${fmtJpy(stats.asRenter.totalSpentJPY)}）`)
        : null,
    ),
  ];
  if (stats.asProvider) {
    cards.push(el('div', { class: 'card' },
      el('div', { class: 'muted', style: 'font-size:0.8rem' }, 'プロバイダーとして'),
      el('div', { style: 'font-size:1.2rem;font-weight:700' }, `${stats.asProvider.total}件`),
      el('div', { class: 'muted', style: 'font-size:0.8rem' }, statusBreakdown(stats.asProvider.byStatus)),
      stats.asProvider.totalEarnedSats > 0
        ? el('div', { style: 'margin-top:4px' }, `収益合計: ${fmtSats(stats.asProvider.totalEarnedSats)}（約${fmtJpy(stats.asProvider.totalEarnedJPY)}）`)
        : null,
    ));
  }
  return el('div', { class: 'grid' }, ...cards);
}

export async function render(container) {
  const statsWrap = el('div', { class: 'stack' }, skeleton('card', 2));
  const listWrap = el('div', { class: 'table-wrap' }, skeleton('line', 5));
  container.appendChild(
    el('div', { class: 'stack' },
      el('h1', {}, '注文一覧'),
      statsWrap,
      listWrap,
    )
  );

  api.orderStats()
    .then((stats) => statsWrap.replaceChildren(statsHeader(stats)))
    .catch(() => statsWrap.replaceChildren()); // stats are a bonus — don't block the page on failure

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
