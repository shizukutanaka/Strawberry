// public/js/pages/market.js — GPU browse with filters and cards.
import { el, skeleton, emptyState, reliabilityBadge, attestationBadge } from '../ui.js';
import { api, ApiError } from '../api.js';
import { getRate, priceLine } from '../rate.js';
import { isAuthenticated } from '../auth.js';
import { navigate } from '../router.js';
import { openRentModal } from '../rent-modal.js';

const VENDORS = ['NVIDIA', 'AMD', 'Intel'];

function gpuCard(gpu, rateInfo, onRent) {
  const price = priceLine(gpu.pricePerHour, rateInfo, '/時');
  const ratingText = gpu.rating && gpu.rating.count > 0
    ? `★${gpu.rating.average} (${gpu.rating.count})`
    : '評価なし';
  return el('div', { class: 'card gpu-card' },
    el('h3', { style: 'cursor:pointer', onClick: () => navigate(`#/gpus/${gpu.id}`) }, gpu.name),
    el('div', { class: 'chips' },
      el('span', { class: 'chip' }, gpu.vendor),
      el('span', { class: 'chip' }, gpu.apiType),
      el('span', { class: 'chip' }, `${gpu.memoryGB}GB`),
      gpu.available === false ? el('span', { class: 'chip' }, '貸出中') : null,
    ),
    el('p', { class: 'muted', style: 'font-size:0.85rem;margin:0' }, gpu.model),
    el('p', { class: 'muted', style: 'font-size:0.8rem;margin:0;cursor:pointer', onClick: () => navigate(`#/gpus/${gpu.id}`) }, ratingText),
    reliabilityBadge(gpu.reliability),
    attestationBadge(gpu.attestation),
    el('div', { class: 'price' },
      el('div', { class: 'sats' }, price.sats),
      price.jpy ? el('div', { class: 'jpy' }, price.jpy) : null,
    ),
    el('button', {
      class: 'btn btn-primary btn-block',
      disabled: gpu.available === false,
      onClick: () => onRent(gpu),
    }, gpu.available === false ? '貸出中' : '借りる'),
  );
}

export async function render(container) {
  const state = { vendor: '', minMemoryGB: '', maxPrice: '', search: '', sort: '' };

  const vendorSelect = el('select', { onChange: (e) => { state.vendor = e.target.value; load(); } },
    el('option', { value: '' }, 'すべてのベンダー'),
    ...VENDORS.map((v) => el('option', { value: v }, v)),
  );
  const sortSelect = el('select', { onChange: (e) => { state.sort = e.target.value; load(); } },
    el('option', { value: '' }, '価格が安い順'),
    el('option', { value: 'rating' }, '評価が高い順'),
    el('option', { value: 'reliability' }, '稼働が安定している順'),
    el('option', { value: 'memory' }, 'メモリが大きい順'),
    el('option', { value: 'availability' }, '空き優先'),
  );
  const memInput = el('input', { type: 'number', min: '0', placeholder: '例: 8', onInput: (e) => { state.minMemoryGB = e.target.value; } });
  const priceInput = el('input', { type: 'number', min: '0', placeholder: 'sats/時', onInput: (e) => { state.maxPrice = e.target.value; } });
  const searchInput = el('input', { type: 'search', placeholder: 'GPU名・モデルで検索', onInput: (e) => { state.search = e.target.value; } });
  const applyBtn = el('button', { class: 'btn btn-primary', onClick: () => load() }, '絞り込み');

  const grid = el('div', { class: 'grid' });

  container.appendChild(
    el('div', { class: 'stack' },
      el('div', { class: 'section-title' }, el('h1', {}, 'GPUマーケット')),
      el('div', { class: 'filter-bar' },
        el('div', { class: 'field' }, el('label', {}, 'ベンダー'), vendorSelect),
        el('div', { class: 'field' }, el('label', {}, '並び順'), sortSelect),
        el('div', { class: 'field' }, el('label', {}, '最小メモリ(GB)'), memInput),
        el('div', { class: 'field' }, el('label', {}, '上限価格(sats/時)'), priceInput),
        el('div', { class: 'field' }, el('label', {}, '検索'), searchInput),
        applyBtn,
      ),
      grid,
    )
  );

  // Guards against an out-of-order response: the initial unfiltered load (large
  // payload, e.g. 70+ GPUs) can resolve AFTER a subsequent filtered/narrower
  // search triggered by the user, silently clobbering the correct narrow
  // result with the stale broad one a moment later. Only the response to the
  // most recently issued request is allowed to render.
  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    grid.replaceChildren(skeleton('card', 6));
    try {
      const [gpuRes, rateInfo] = await Promise.all([
        api.listGpus({
          vendor: state.vendor || undefined,
          minMemoryGB: state.minMemoryGB || undefined,
          maxPrice: state.maxPrice || undefined,
          search: state.search || undefined,
          sort: state.sort || undefined,
        }),
        getRate(),
      ]);
      if (seq !== loadSeq) return; // a newer load() superseded this one
      grid.replaceChildren();
      if (!gpuRes.gpus.length) {
        grid.replaceChildren(emptyState('🖥️', '該当するGPUがありません', '条件を変えて再度お試しください。'));
        return;
      }
      gpuRes.gpus.forEach((gpu) => {
        grid.appendChild(gpuCard(gpu, rateInfo, (g) => {
          if (!isAuthenticated()) {
            navigate('#/login?next=market');
            return;
          }
          openRentModal(g, rateInfo);
        }));
      });
    } catch (err) {
      if (seq !== loadSeq) return;
      grid.replaceChildren(emptyState('⚠️', 'GPU一覧の取得に失敗しました', err instanceof ApiError ? err.message : ''));
    }
  }

  await load();
}
