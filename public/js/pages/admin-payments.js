// public/js/pages/admin-payments.js — admin queue of pending manual (bank
// transfer) payments awaiting approval.
import { el, skeleton, emptyState, toast, fmtDate, fmtSats, confirmDialog } from '../ui.js';
import { api, ApiError } from '../api.js';
import { navigate } from '../router.js';

const METHOD_LABELS = { bank_transfer: '銀行振込' };

export async function render(container) {
  const listWrap = el('div', { class: 'table-wrap manual-queue' }, skeleton('line', 4));
  const payoutWrap = el('div', { class: 'table-wrap payout-queue' }, skeleton('line', 3));
  container.appendChild(
    el('div', { class: 'stack' },
      el('h1', {}, '決済承認'),
      el('p', { class: 'muted' }, '銀行振込等、管理者の承認が必要な決済の一覧です。'),
      listWrap,
      el('h2', { style: 'margin-top:16px' }, '出金待ち'),
      el('p', { class: 'muted' },
        'プロバイダ・借り手からの出金申請です。実際の送金は運営が LN / オンチェーンで行い、'
        + 'ここに取引 ID を記録します。取引 ID を記録するまで台帳は「送金待ち」のままです。'),
      payoutWrap,
    )
  );

  async function settlePayout(p, row) {
    // 取引 ID をこの場で入力させる。ID 無しで「送金済み」にできると、
    // 台帳上は払ったのに実際は送っていない状態を後から誰も検出できない。
    const input = row.querySelector('.js-txid');
    const txid = (input.value || '').trim();
    if (txid.length < 4) {
      toast('送金の取引 ID を入力してください', 'error');
      input.focus();
      return;
    }
    const ok = await confirmDialog(
      `${fmtSats(p.amountSats)} を ${p.destination} へ送金済みとして記録します。\n取引 ID: ${txid}`);
    if (!ok) return;
    const btn = row.querySelector('.js-settle');
    btn.disabled = true;
    try {
      await api.completePayout(p.id, txid);
      toast('出金を送金済みとして記録しました', 'success');
      await loadPayouts();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '記録に失敗しました', 'error');
      btn.disabled = false;
    }
  }

  async function rejectPayoutRow(p) {
    const ok = await confirmDialog(`出金申請 ${fmtSats(p.amountSats)}（${p.username || '不明なユーザー'}）を却下しますか？\n残高は申請者へ戻ります。`);
    if (!ok) return;
    try {
      await api.rejectPayout(p.id, 'rejected by operator');
      toast('出金申請を却下しました', 'success');
      await loadPayouts();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '却下に失敗しました', 'error');
    }
  }

  async function loadPayouts() {
    payoutWrap.replaceChildren(skeleton('line', 3));
    try {
      const res = await api.pendingPayouts();
      if (!res.payouts.length) {
        payoutWrap.replaceChildren(emptyState('✅', '出金待ちはありません', ''));
        return;
      }
      const table = el('table', { class: 'data-table payout-table' },
        el('thead', {}, el('tr', {},
          el('th', {}, '金額'), el('th', {}, '申請者'), el('th', {}, '送金先'),
          el('th', {}, '申請日'), el('th', {}, '取引 ID'), el('th', {}, '操作'))),
        el('tbody', {}, ...res.payouts.map((p) => {
          const row = el('tr', {},
            el('td', { 'data-label': '金額' }, fmtSats(p.amountSats)),
            el('td', { 'data-label': '申請者' }, p.username || '—'),
            el('td', { 'data-label': '送金先', class: 'mono' }, p.destination || '—'),
            el('td', { 'data-label': '申請日' }, fmtDate(p.requestedAt || p.createdAt)),
            el('td', { 'data-label': '取引 ID' },
              el('input', { class: 'js-txid', type: 'text', placeholder: '送金後の txid / payment hash' })),
            el('td', { 'data-label': '操作' },
              el('button', { class: 'btn btn-primary btn-sm js-settle', onClick: () => settlePayout(p, row) }, '送金済みにする'),
              el('button', { class: 'btn btn-ghost btn-sm js-reject', onClick: () => rejectPayoutRow(p) }, '却下')),
          );
          return row;
        })),
      );
      payoutWrap.replaceChildren(table);
    } catch (err) {
      payoutWrap.replaceChildren(emptyState('⚠️', '取得に失敗しました', err instanceof ApiError ? err.message : ''));
    }
  }

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
      const table = el('table', { class: 'data-table manual-payments' },
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

  await Promise.all([load(), loadPayouts()]);
}
