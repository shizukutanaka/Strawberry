// public/js/pages/earnings.js — 収益ページ。
//
// 2 種類の数字を**明確に区別して**出す。混ぜると嘘になる:
//   1. 受取可能残高（GET /payments/earnings）… 台帳に計上済みで、実際に出金申請できる額。
//   2. 注文総額の集計（GET /orders/provider/earnings）… 借り手が払う「注文の値段」の合計。
//      運営手数料も、未払い注文も、未提供分の返金も差し引かれていない。
// 以前はこのページが 2 だけを「収益」と表示していた。当時は受け取る手段が
// 実装されていなかったので、貸し手は受け取れない金額を収益として見せられていた。
import { el, skeleton, emptyState, fmtSats, fmtJpy, toast, confirmDialog } from '../ui.js';
import { api, ApiError } from '../api.js';

function statCard(label, satsValue, jpyValue, sub) {
  return el('div', { class: 'card' },
    el('div', { class: 'muted', style: 'font-size:0.8rem' }, label),
    el('div', { style: 'font-size:1.4rem;font-weight:700' }, fmtSats(satsValue)),
    jpyValue != null ? el('div', { class: 'muted', style: 'font-size:0.85rem' }, `約${fmtJpy(jpyValue)}（概算）`) : null,
    sub ? el('div', { class: 'muted', style: 'font-size:0.8rem;margin-top:4px' }, sub) : null,
  );
}

const KIND_LABEL = {
  earning: '売上計上', refund: '返金受取', payout: '出金', adjustment: '調整',
};
const PAYOUT_STATUS_LABEL = {
  requested: '送金待ち', paid: '送金済み', rejected: '却下', settled: '確定',
};

export async function render(container) {
  const fromInput = el('input', { type: 'date' });
  const toInput = el('input', { type: 'date' });
  const applyBtn = el('button', { class: 'btn btn-primary' }, '絞り込み');
  const resultBox = el('div', { class: 'stack' }, skeleton('card', 3));
  const balanceBox = el('div', { class: 'stack balance-box' }, skeleton('card', 1));

  container.appendChild(
    el('div', { class: 'stack' },
      el('h1', {}, '収益'),
      balanceBox,
      el('h2', { style: 'margin-top:8px' }, '注文総額の集計'),
      el('p', { class: 'muted', style: 'font-size:0.85rem' },
        '以下は注文の値段の合計です。運営手数料・未払い・未提供分の返金は差し引かれていません。実際に受け取れる額は上の「受取可能残高」を見てください。'),
      el('div', { class: 'filter-bar' },
        el('div', { class: 'field' }, el('label', {}, '開始日'), fromInput),
        el('div', { class: 'field' }, el('label', {}, '終了日'), toInput),
        applyBtn,
      ),
      resultBox,
    )
  );

  async function loadBalance() {
    balanceBox.replaceChildren(skeleton('card', 1));
    let data;
    try {
      data = await api.ledger({ limit: 50 });
    } catch (err) {
      balanceBox.replaceChildren(
        emptyState('⚠️', '残高を取得できませんでした', err instanceof ApiError ? err.message : ''));
      return;
    }
    const b = data.balance;
    const payoutBtn = el('button', { class: 'btn btn-primary btn-payout' }, '出金を申請');
    if (b.availableSats < data.minimumPayoutSats) {
      payoutBtn.disabled = true;
      payoutBtn.title = `出金は ${fmtSats(data.minimumPayoutSats)} 以上から申請できます`;
    }

    payoutBtn.addEventListener('click', async () => {
      const ok = await confirmDialog(
        `受取可能残高 ${fmtSats(b.availableSats)} の全額を、登録済みの受取アドレスへ出金申請します。\n` +
        '送金は運営が手動で行い、完了時に取引 ID が記録されます。');
      if (!ok) return;
      payoutBtn.disabled = true;
      try {
        await api.requestPayout(b.availableSats);
        toast('出金を申請しました。運営の送金をお待ちください。', 'success');
        await loadBalance();
      } catch (err) {
        const reason = err instanceof ApiError ? err.message : '';
        toast(reason.includes('no_payout_address')
          ? '受取アドレスが未登録です。プロフィールで payoutAddress を設定してください。'
          : `出金申請に失敗しました: ${reason}`, 'error');
        payoutBtn.disabled = false;
      }
    });

    const summary = el('div', { class: 'card stack balance-card' },
      el('div', { class: 'muted', style: 'font-size:0.8rem' }, '受取可能残高'),
      el('div', { class: 'balance-amount', style: 'font-size:1.8rem;font-weight:700' }, fmtSats(b.availableSats)),
      el('div', { class: 'muted', style: 'font-size:0.85rem' },
        `計上済み ${fmtSats(b.earnedSats)} ／ 送金待ち ${fmtSats(b.reservedSats)} ／ 送金済み ${fmtSats(b.paidOutSats)}`),
      el('div', { class: 'muted', style: 'font-size:0.8rem' },
        `出金の最低額: ${fmtSats(data.minimumPayoutSats)}。送金は運営が手動で実行し、取引 ID が明細に記録されます。`),
      payoutBtn,
    );

    const entries = data.entries || [];
    const historyRows = entries.map((e) => el('tr', {},
      el('td', { 'data-label': '日付' }, (e.createdAt || '').slice(0, 10)),
      el('td', { 'data-label': '種別' }, KIND_LABEL[e.kind] || e.kind),
      el('td', { 'data-label': '金額' }, `${e.kind === 'payout' ? '-' : '+'}${fmtSats(e.amountSats)}`),
      el('td', { 'data-label': '状態' },
        PAYOUT_STATUS_LABEL[e.status] || e.status,
        e.txid ? el('span', { class: 'muted', style: 'display:block;font-size:0.75rem' }, `tx: ${e.txid}`) : null),
    ));
    const history = entries.length
      ? el('table', { class: 'data-table ledger-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, '日付'), el('th', {}, '種別'), el('th', {}, '金額'), el('th', {}, '状態'))),
          el('tbody', {}, ...historyRows))
      : el('p', { class: 'muted' }, '台帳の明細はまだありません。注文が完了し支払いが確認されると計上されます。');

    balanceBox.replaceChildren(summary, el('h3', { style: 'margin-top:4px' }, '台帳明細'), history);
  }

  async function load() {
    resultBox.replaceChildren(skeleton('card', 3));
    try {
      const query = {};
      if (fromInput.value) query.from = new Date(fromInput.value).toISOString();
      if (toInput.value) query.to = new Date(toInput.value).toISOString();
      const { earnings } = await api.providerEarnings(query);

      if (earnings.completedCount === 0 && earnings.activeCount === 0 && earnings.cancelledCount === 0) {
        resultBox.replaceChildren(emptyState('💰', 'まだ収益データがありません', 'GPUが利用されると、ここに収益が表示されます。'));
        return;
      }

      const cards = el('div', { class: 'grid' },
        statCard('完了注文の総額', earnings.completedSats, earnings.completedJPY, `${earnings.completedCount}件（手数料控除前）`),
        statCard('稼働中（見込み）', earnings.activeSats, null, `${earnings.activeCount}件の注文`),
        el('div', { class: 'card' },
          el('div', { class: 'muted', style: 'font-size:0.8rem' }, 'キャンセル'),
          el('div', { style: 'font-size:1.4rem;font-weight:700' }, `${earnings.cancelledCount}件`),
        ),
      );

      const gpuSection = el('div', { class: 'stack' }, el('h3', {}, 'GPU別内訳'));
      if (!earnings.byGpu.length) {
        gpuSection.appendChild(el('p', { class: 'muted' }, '完了済みの注文がまだありません。'));
      } else {
        const table = el('table', { class: 'data-table gpu-breakdown' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'GPU'), el('th', {}, '完了件数'), el('th', {}, '注文総額'))),
          el('tbody', {}, ...earnings.byGpu.map((g) => el('tr', {},
            el('td', { 'data-label': 'GPU' }, g.gpuName || g.gpuId.slice(0, 8)),
            el('td', { 'data-label': '完了件数' }, `${g.completedCount}件`),
            el('td', { 'data-label': '注文総額' }, `${fmtSats(g.completedSats)}${g.completedJPY != null ? ` (約${fmtJpy(g.completedJPY)})` : ''}`),
          ))),
        );
        gpuSection.appendChild(table);
      }

      resultBox.replaceChildren(cards, gpuSection);
    } catch (err) {
      resultBox.replaceChildren(emptyState('⚠️', '取得に失敗しました', err instanceof ApiError ? err.message : ''));
    }
  }

  applyBtn.addEventListener('click', load);
  await Promise.all([loadBalance(), load()]);
}
