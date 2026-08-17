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
  // 課金ティア。spot（中断許容）は割引と引き換えにプロバイダ都合の中断を受け入れる。
  const spot = gpu.spot && gpu.spot.enabled ? gpu.spot : null;
  let selectedTier = 'ondemand';
  const backdrop = el('div', { class: 'modal-backdrop' });
  const estimateBox = el('div', { class: 'banner banner-info' });
  // 中断の条件は「安さ」と同じ大きさで見せる。割引だけ見せて中断リスクを小さく書くのは
  // 借り手に不利な情報の隠蔽になる。
  const spotWarning = el('div', { class: 'banner banner-warning', style: 'display:none' });

  function currentRate() {
    return selectedTier === 'spot' && spot && spot.pricePerHour ? spot.pricePerHour : gpu.pricePerHour;
  }

  function updateEstimate() {
    const totalSats = Math.round((currentRate() / 12) * (selectedMinutes / 5));
    const price = priceLine(totalSats, rateInfo);
    estimateBox.textContent = `合計目安: ${price.sats}${price.jpy ? '（' + price.jpy + '）' : ''}`;
    if (spot && selectedTier === 'spot') {
      const rate = spot.providerPreemptionRate;
      const rateText = rate && rate.rate != null
        ? `このプロバイダーの実績中断率: ${Math.round(rate.rate * 100)}%（${rate.spotOrders}件中）`
        : 'このプロバイダーの中断実績はまだ十分に蓄積されていません';
      spotWarning.textContent =
        `中断される可能性があります。提供者が中断を通知してから停止までの猶予は ${spot.noticeSeconds} 秒です。`
        + `作業状態はこの猶予内に保存してください。中断された場合、課金は実際に提供された時間分のみです。`
        + ` ${rateText}`;
      spotWarning.style.display = '';
    } else {
      spotWarning.style.display = 'none';
    }
  }

  const tierButtons = spot ? ['ondemand', 'spot'].map((t) =>
    el('button', {
      type: 'button',
      class: `btn btn-ghost btn-sm${t === selectedTier ? ' active' : ''}`,
      onClick: (e) => {
        selectedTier = t;
        [...e.target.parentElement.children].forEach((c) => c.classList.remove('active'));
        e.target.classList.add('active');
        updateEstimate();
      },
    }, t === 'ondemand' ? '専有（中断なし）' : `中断許容（${spot.discountPct}%引き）`)
  ) : [];

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
        const res = await api.createOrder(gpu.id, selectedMinutes, selectedTier);
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
    spot ? el('div', { class: 'field' },
      el('label', {}, '課金ティア'),
      el('div', { class: 'row', style: 'flex-wrap:wrap', 'data-testid': 'tier-picker' }, ...tierButtons),
    ) : null,
    spotWarning,
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
