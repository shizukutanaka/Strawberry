// public/js/pages/admin-payments.js — admin queue of pending manual (bank
// transfer) payments awaiting approval.
import { el, skeleton, emptyState, toast, fmtDate, fmtSats, confirmDialog } from '../ui.js';
import { api, ApiError } from '../api.js';
import { navigate } from '../router.js';

const METHOD_LABELS = { bank_transfer: '銀行振込' };

export async function render(container) {
  const listWrap = el('div', { class: 'table-wrap manual-queue' }, skeleton('line', 4));
  const payoutWrap = el('div', { class: 'table-wrap payout-queue' }, skeleton('line', 3));
  const reconBox = el('div', { class: 'stack recon-box' }, skeleton('card', 1));
  container.appendChild(
    el('div', { class: 'stack' },
      el('h1', {}, '決済承認'),
      el('p', { class: 'muted' }, '銀行振込等、管理者の承認が必要な決済の一覧です。'),
      listWrap,
      reconBox,
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

  // 帳簿の突き合わせ。運営は他人の金を預かっているので、「いくら預かっていて
  // いくら払う義務があるか」と「不変条件が保たれているか」が一目で分かる必要がある。
  async function loadReconciliation() {
    reconBox.replaceChildren(skeleton('card', 1));
    let r;
    try {
      r = await api.reconciliation();
    } catch (err) {
      reconBox.replaceChildren(
        emptyState('⚠️', '帳簿の突き合わせを取得できませんでした', err instanceof ApiError ? err.message : ''));
      return;
    }
    const t = r.totals;
    const problems = [
      !r.invariants.conservationHolds
        ? `保存則違反 ${r.discrepancies.length} 件（入金額と計上額が一致しない注文）` : null,
      !r.invariants.noUncreditedTerminalOrders
        ? `未計上の終端注文 ${r.uncreditedTerminal.length} 件（支払い済みなのに台帳に載っていない）` : null,
      !r.invariants.noOrphanCredits
        ? `出所のない計上 ${r.orphanCredits.length} 件（対応する入金が無い）` : null,
    ].filter(Boolean);

    const row = (label, value, hint) => el('div', { class: 'row-between', style: 'padding:3px 0' },
      el('span', { class: 'muted' }, label),
      el('span', {}, fmtSats(value), hint ? el('span', { class: 'muted', style: 'font-size:0.75rem;margin-left:6px' }, hint) : null));

    reconBox.replaceChildren(
      el('h2', {}, '帳簿の突き合わせ'),
      el('div', { class: `card stack recon-card ${r.healthy ? 'recon-ok' : 'recon-bad'}` },
        el('div', { class: 'row-between' },
          el('strong', {}, r.healthy ? '✅ 帳簿は整合しています' : '⚠️ 帳簿に不整合があります'),
          el('span', { class: 'muted', style: 'font-size:0.8rem' },
            `支払い済み注文 ${r.invariants.paidOrders} 件 / 計上済み ${r.invariants.creditedOrders} 件`)),
        problems.length
          ? el('ul', { class: 'recon-problems' }, ...problems.map((p) => el('li', {}, p)))
          : null,
        el('hr'),
        row('借り手から受け取った額', t.renterPaidSats),
        row('貸し手に計上した額', t.providerEarnedSats),
        row('借り手に返金として計上した額', t.renterRefundedSats),
        row('運営手数料（収益）', t.operatorFeeSats),
        row('送金済み', t.payoutPaidSats),
        row('送金待ち（申請中）', t.payoutRequestedSats),
        el('div', { class: 'row-between', style: 'padding:6px 0;border-top:1px solid var(--color-border);margin-top:4px' },
          el('strong', {}, '未払いの債務（預かり中）'),
          el('strong', { class: 'recon-liability' }, fmtSats(t.outstandingLiabilitySats))),
        el('p', { class: 'muted', style: 'font-size:0.8rem' },
          'これは運営が利用者のために保持しているべき額です。実際のウォレット残高がこれを下回っていれば、'
          + '出金申請をすべて満たせません。'),
      ),
    );
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

  await Promise.all([load(), loadPayouts(), loadReconciliation()]);
}
