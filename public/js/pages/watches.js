// public/js/pages/watches.js — "My price watches" list.
// The backend GET /users/me/watches (enriched with GPU info) existed but had no
// UI: watches could only be set/removed one GPU at a time from the detail page,
// with no way to see them all together. This page lists every active watch with
// its target vs. current price and a drop-achieved indicator, and lets the user
// remove a watch or jump to the GPU.
import { el, skeleton, emptyState, toast, fmtSats } from '../ui.js';
import { api, ApiError } from '../api.js';
import { navigate } from '../router.js';

function watchRow(w, onRemove) {
  const gpu = w.gpu;
  const gpuGone = !gpu;
  const current = gpu ? gpu.pricePerHour : null;
  const target = w.targetPrice;
  // 値下げ達成: 現在価格が目標以下（GPU が存在する場合のみ判定できる）。
  const achieved = gpu && typeof current === 'number' && current <= target;

  const nameCell = gpuGone
    ? el('span', { class: 'muted' }, '（削除されたGPU）')
    : el('a', { href: `#/gpus/${gpu.id}`, style: 'cursor:pointer' }, gpu.name);

  const statusChip = gpuGone
    ? el('span', { class: 'chip' }, '対象なし')
    : achieved
      ? el('span', { class: 'chip chip-success' }, '値下げ達成')
      : el('span', { class: 'chip' }, '監視中');

  const removeBtn = el('button', { class: 'btn btn-ghost btn-sm', onClick: () => onRemove(w) }, '解除');

  return el('tr', {},
    el('td', { 'data-label': 'GPU' }, nameCell),
    el('td', { 'data-label': '目標価格' }, `${fmtSats(target)}/時`),
    el('td', { 'data-label': '現在価格' }, gpuGone ? '—' : `${fmtSats(current)}/時`),
    el('td', { 'data-label': '状態' }, statusChip),
    el('td', { 'data-label': '' }, removeBtn),
  );
}

export async function render(container) {
  const root = el('div', { class: 'stack' },
    el('h1', {}, '価格ウォッチ'),
    el('p', { class: 'muted' }, 'GPU が目標価格以下になると通知されます。GPU 詳細ページから追加できます。'),
    el('div', { class: 'stack' }, skeleton('line', 4)),
  );
  container.appendChild(root);
  const body = root.lastChild;

  async function load() {
    body.replaceChildren(skeleton('line', 4));
    let watches;
    try {
      ({ watches } = await api.myWatches());
    } catch (err) {
      body.replaceChildren(emptyState('⚠️', '取得に失敗しました', err instanceof ApiError ? err.message : ''));
      return;
    }
    if (!watches.length) {
      body.replaceChildren(emptyState('🔔', 'ウォッチはまだありません',
        'マーケットで GPU を開き「通知を設定」すると、値下げ時に通知を受け取れます。'));
      return;
    }

    async function onRemove(w) {
      if (!w.gpu) {
        // GPU が消えている場合も watch レコードは残る。gpuId 経由で解除する。
        try { await api.removeGpuWatch(w.gpuId); toast('ウォッチを解除しました', 'success'); } catch (e) { toast(e.message, 'error'); }
        return load();
      }
      try {
        await api.removeGpuWatch(w.gpu.id);
        toast('ウォッチを解除しました', 'success');
      } catch (e) {
        toast(e instanceof ApiError ? e.message : 'ウォッチ解除に失敗しました', 'error');
      }
      load();
    }

    const table = el('table', { class: 'data-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'GPU'), el('th', {}, '目標価格'), el('th', {}, '現在価格'), el('th', {}, '状態'), el('th', {}, ''))),
      el('tbody', {}, ...watches.map((w) => watchRow(w, onRemove))),
    );
    body.replaceChildren(table);
  }

  await load();
}
