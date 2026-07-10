// public/js/pages/earnings.js — provider earnings summary (GET /orders/provider/earnings).
import { el, skeleton, emptyState, fmtSats, fmtJpy } from '../ui.js';
import { api, ApiError } from '../api.js';

function statCard(label, satsValue, jpyValue, sub) {
  return el('div', { class: 'card' },
    el('div', { class: 'muted', style: 'font-size:0.8rem' }, label),
    el('div', { style: 'font-size:1.4rem;font-weight:700' }, fmtSats(satsValue)),
    jpyValue != null ? el('div', { class: 'muted', style: 'font-size:0.85rem' }, `約${fmtJpy(jpyValue)}（概算）`) : null,
    sub ? el('div', { class: 'muted', style: 'font-size:0.8rem;margin-top:4px' }, sub) : null,
  );
}

export async function render(container) {
  const fromInput = el('input', { type: 'date' });
  const toInput = el('input', { type: 'date' });
  const applyBtn = el('button', { class: 'btn btn-primary' }, '絞り込み');
  const resultBox = el('div', { class: 'stack' }, skeleton('card', 3));

  container.appendChild(
    el('div', { class: 'stack' },
      el('h1', {}, '収益'),
      el('div', { class: 'filter-bar' },
        el('div', { class: 'field' }, el('label', {}, '開始日'), fromInput),
        el('div', { class: 'field' }, el('label', {}, '終了日'), toInput),
        applyBtn,
      ),
      resultBox,
    )
  );

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
        statCard('完了済み収益', earnings.completedSats, earnings.completedJPY, `${earnings.completedCount}件の注文`),
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
        const table = el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'GPU'), el('th', {}, '完了件数'), el('th', {}, '収益'))),
          el('tbody', {}, ...earnings.byGpu.map((g) => el('tr', {},
            el('td', { 'data-label': 'GPU' }, g.gpuName || g.gpuId.slice(0, 8)),
            el('td', { 'data-label': '完了件数' }, `${g.completedCount}件`),
            el('td', { 'data-label': '収益' }, `${fmtSats(g.completedSats)}${g.completedJPY != null ? ` (約${fmtJpy(g.completedJPY)})` : ''}`),
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
  await load();
}
