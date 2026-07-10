// public/js/rent-modal.js — shared rent modal (duration picker + order
// creation), extracted from market.js so gpu-detail.js can reuse it without
// duplicating the estimate/preset/order-creation logic.
import { el, toast } from './ui.js';
import { api, ApiError } from './api.js';
import { priceLine } from './rate.js';
import { navigate } from './router.js';

const DURATION_PRESETS = [
  { label: '30分', minutes: 30 },
  { label: '1時間', minutes: 60 },
  { label: '3時間', minutes: 180 },
  { label: '12時間', minutes: 720 },
];

export function openRentModal(gpu, rateInfo) {
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
