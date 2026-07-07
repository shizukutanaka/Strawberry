// public/js/pages/market.js — GPU browse with filters, cards, and rent modal.
import { el, skeleton, emptyState, toast, fmtSats } from '../ui.js';
import { api, ApiError } from '../api.js';
import { getRate, priceLine } from '../rate.js';
import { isAuthenticated } from '../auth.js';
import { navigate } from '../router.js';

const VENDORS = ['NVIDIA', 'AMD', 'Intel'];
const DURATION_PRESETS = [
  { label: '30分', minutes: 30 },
  { label: '1時間', minutes: 60 },
  { label: '3時間', minutes: 180 },
  { label: '12時間', minutes: 720 },
];

function gpuCard(gpu, rateInfo, onRent) {
  const price = priceLine(gpu.pricePerHour, rateInfo, '/時');
  const ratingText = gpu.rating && gpu.rating.count > 0
    ? `★${gpu.rating.average} (${gpu.rating.count})`
    : '評価なし';
  return el('div', { class: 'card gpu-card' },
    el('h3', {}, gpu.name),
    el('div', { class: 'chips' },
      el('span', { class: 'chip' }, gpu.vendor),
      el('span', { class: 'chip' }, gpu.apiType),
      el('span', { class: 'chip' }, `${gpu.memoryGB}GB`),
      gpu.available === false ? el('span', { class: 'chip' }, '貸出中') : null,
    ),
    el('p', { class: 'muted', style: 'font-size:0.85rem;margin:0' }, gpu.model),
    el('p', { class: 'muted', style: 'font-size:0.8rem;margin:0' }, ratingText),
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

function openRentModal(gpu, rateInfo) {
  let selectedMinutes = 60;
  const backdrop = el('div', { class: 'modal-backdrop' });
  const estimateBox = el('div', { class: 'banner banner-info' });

  function updateEstimate() {
    const totalSats = Math.round((gpu.pricePerHour / 12) * (selectedMinutes / 5));
    const price = priceLine(totalSats, rateInfo);
    estimateBox.textContent = `合計目安: ${price.sats}${price.jpy ? '（' + price.jpy + '）' : ''}`;
  }

  const presetButtons = DURATION_PRESETS.map((p) =>
    el('button', {
      type: 'button',
      class: `btn btn-ghost btn-sm${p.minutes === selectedMinutes ? ' active' : ''}`,
      onClick: (e) => {
        selectedMinutes = p.minutes;
        durationInput.value = String(p.minutes);
        [...e.target.parentElement.children].forEach((c) => c.classList.remove('active'));
        e.target.classList.add('active');
        updateEstimate();
      },
    }, p.label)
  );

  const durationInput = el('input', {
    type: 'number', min: '5', step: '5', value: String(selectedMinutes),
    onInput: (e) => {
      const v = parseInt(e.target.value, 10);
      if (Number.isFinite(v) && v >= 5) { selectedMinutes = v; updateEstimate(); }
    },
  });

  const confirmBtn = el('button', {
    class: 'btn btn-primary',
    onClick: async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = '注文作成中…';
      try {
        const res = await api.createOrder(gpu.id, selectedMinutes);
        toast('注文を作成しました', 'success');
        backdrop.remove();
        navigate(`#/orders/${res.orderId}`);
      } catch (err) {
        toast(err instanceof ApiError ? err.message : '注文の作成に失敗しました', 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = '注文する';
      }
    },
  }, '注文する');

  updateEstimate();

  const modal = el('div', { class: 'modal' },
    el('h3', {}, `${gpu.name} を借りる`),
    el('div', { class: 'row', style: 'flex-wrap:wrap;margin-bottom:8px' }, ...presetButtons),
    el('div', { class: 'field' },
      el('label', {}, '利用時間（分・5分単位）'),
      durationInput,
    ),
    estimateBox,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn btn-ghost', onClick: () => backdrop.remove() }, 'キャンセル'),
      confirmBtn,
    ),
  );
  backdrop.appendChild(modal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
}

export async function render(container) {
  const state = { vendor: '', minMemoryGB: '', maxPrice: '', search: '' };

  const vendorSelect = el('select', { onChange: (e) => { state.vendor = e.target.value; load(); } },
    el('option', { value: '' }, 'すべてのベンダー'),
    ...VENDORS.map((v) => el('option', { value: v }, v)),
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
        el('div', { class: 'field' }, el('label', {}, '最小メモリ(GB)'), memInput),
        el('div', { class: 'field' }, el('label', {}, '上限価格(sats/時)'), priceInput),
        el('div', { class: 'field' }, el('label', {}, '検索'), searchInput),
        applyBtn,
      ),
      grid,
    )
  );

  async function load() {
    grid.replaceChildren(skeleton('card', 6));
    try {
      const [gpuRes, rateInfo] = await Promise.all([
        api.listGpus({
          vendor: state.vendor || undefined,
          minMemoryGB: state.minMemoryGB || undefined,
          maxPrice: state.maxPrice || undefined,
          search: state.search || undefined,
        }),
        getRate(),
      ]);
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
      grid.replaceChildren(emptyState('⚠️', 'GPU一覧の取得に失敗しました', err instanceof ApiError ? err.message : ''));
    }
  }

  await load();
}
