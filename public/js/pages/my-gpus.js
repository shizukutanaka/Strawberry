// public/js/pages/my-gpus.js — provider's own GPU inventory + availability toggle.
import { el, skeleton, emptyState, toast, fmtSats } from '../ui.js';
import { api, ApiError } from '../api.js';

export async function render(container) {
  const listWrap = el('div', { class: 'table-wrap' }, skeleton('line', 4));

  container.appendChild(
    el('div', { class: 'stack' },
      el('div', { class: 'section-title' },
        el('h1', {}, 'マイGPU'),
        el('a', { href: '#/gpus/new', class: 'btn btn-primary' }, '+ GPUを登録'),
      ),
      listWrap,
    )
  );

  // gpu.available is undefined for a freshly-created GPU (the backend only sets
  // it explicitly once toggled) — treat anything but an explicit false as
  // "available" consistently for both display and the toggle computation, or
  // the first click flips the wrong direction (undefined -> !undefined -> true,
  // even when the user clicked "stop lending" on an already-available GPU).
  function isAvailable(gpu) {
    return gpu.available !== false;
  }

  async function toggleAvailable(gpu, row) {
    const btn = row.querySelector('.js-toggle');
    btn.disabled = true;
    try {
      const next = !isAvailable(gpu);
      await api.updateGpu(gpu.id, { available: next });
      gpu.available = next;
      toast(next ? '貸出可能にしました' : '貸出停止にしました', 'success');
      renderRow(gpu, row);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '更新に失敗しました', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function renderRow(gpu, existingRow) {
    const row = existingRow || el('tr');
    row.replaceChildren(
      el('td', { 'data-label': 'GPU名' }, gpu.name),
      el('td', { 'data-label': 'モデル' }, gpu.model),
      el('td', { 'data-label': '価格' }, `${fmtSats(gpu.pricePerHour)}/時`),
      el('td', { 'data-label': '状態' }, isAvailable(gpu) ? '貸出可能' : '貸出停止中'),
      el('td', { 'data-label': '操作' },
        el('button', {
          class: 'btn btn-ghost btn-sm js-toggle',
          onClick: () => toggleAvailable(gpu, row),
        }, isAvailable(gpu) ? '貸出停止' : '貸出再開'),
      ),
    );
    return row;
  }

  try {
    const res = await api.myGpus();
    if (!res.gpus.length) {
      listWrap.replaceChildren(
        emptyState('🖥️', 'まだGPUを登録していません', '最初のGPUを登録して貸出を始めましょう。',
          el('a', { href: '#/gpus/new', class: 'btn btn-primary' }, 'GPUを登録する'))
      );
      return;
    }
    const table = el('table', { class: 'data-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'GPU名'), el('th', {}, 'モデル'), el('th', {}, '価格'), el('th', {}, '状態'), el('th', {}, '操作'))),
      el('tbody', {}, ...res.gpus.map((gpu) => renderRow(gpu))),
    );
    listWrap.replaceChildren(table);
  } catch (err) {
    listWrap.replaceChildren(emptyState('⚠️', '取得に失敗しました', err instanceof ApiError ? err.message : ''));
  }
}
