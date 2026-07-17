// public/js/pages/admin-payments.js — admin queue of pending manual (bank
// transfer) payments awaiting approval.
import { el, skeleton, emptyState, toast, fmtDate, fmtSats, confirmDialog } from '../ui.js';
import { api, ApiError } from '../api.js';
import { navigate } from '../router.js';

const METHOD_LABELS = { bank_transfer: '銀行振込' };

export async function render(container) {
  const listWrap = el('div', { class: 'table-wrap' }, skeleton('line', 4));
  container.appendChild(
    el('div', { class: 'stack' },
      el('h1', {}, '決済承認'),
      el('p', { class: 'muted' }, '銀行振込等、管理者の承認が必要な決済の一覧です。'),
      listWrap,
    )
  );

  async function approve(payment, row) {
    const ok = await confirmDialog(`支払い ${fmtSats(payment.amount)}（${payment.renterUsername || '不明なユーザー'}）を承認しますか？`);
    if (!ok) return;
    const btn = row.querySelector('.js-approve');
    btn.disabled = true;
    try {
      await api.approveManualPayment(payment.id);
      toast('決済を承認しました', 'success');
      row.remove();
      const remaining = listWrap.querySelectorAll('tbody tr').length;
      if (remaining === 0) await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '承認に失敗しました', 'error');
      btn.disabled = false;
    }
  }

  async function load() {
    listWrap.replaceChildren(skeleton('line', 4));
    try {
      const res = await api.pendingManualPayments();
      if (!res.payments.length) {
        listWrap.replaceChildren(emptyState('✅', '承認待ちの決済はありません', ''));
        return;
      }
      const table = el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {},
          el('th', {}, '金額'), el('th', {}, '方法'), el('th', {}, '借り手'),
          el('th', {}, '注文'), el('th', {}, '申請日'), el('th', {}, '操作'))),
        el('tbody', {}, ...res.payments.map((p) => {
          const row = el('tr', {},
            el('td', { 'data-label': '金額' }, fmtSats(p.amount)),
            el('td', { 'data-label': '方法' }, METHOD_LABELS[p.method] || p.method),
            el('td', { 'data-label': '借り手' }, p.renterUsername || '—'),
            el('td', {
              'data-label': '注文', class: 'mono', style: 'cursor:pointer;color:var(--color-primary)',
              onClick: () => navigate(`#/orders/${p.orderId}`),
            }, p.orderId ? p.orderId.slice(0, 8) : '—'),
            el('td', { 'data-label': '申請日' }, fmtDate(p.createdAt)),
            el('td', { 'data-label': '操作' },
              el('button', { class: 'btn btn-primary btn-sm js-approve', onClick: () => approve(p, row) }, '承認')),
          );
          return row;
        })),
      );
      listWrap.replaceChildren(table);
    } catch (err) {
      listWrap.replaceChildren(emptyState('⚠️', '取得に失敗しました', err instanceof ApiError ? err.message : ''));
    }
  }

  await load();
}
