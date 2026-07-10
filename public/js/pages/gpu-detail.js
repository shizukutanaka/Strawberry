// public/js/pages/gpu-detail.js — full GPU spec + reviews, with a rent CTA.
// Reached by clicking a GPU name/rating in market.js's cards (previously
// there was no way to see full specs or read individual reviews before
// deciding to rent — market.js's cards only ever showed a summary).
import { el, skeleton, emptyState, fmtDate } from '../ui.js';
import { api, ApiError } from '../api.js';
import { getRate, priceLine } from '../rate.js';
import { isAuthenticated } from '../auth.js';
import { navigate } from '../router.js';
import { openRentModal } from '../rent-modal.js';

function specRow(label, value) {
  return el('div', { class: 'row-between', style: 'padding:4px 0;border-bottom:1px solid var(--color-border)' },
    el('span', { class: 'muted' }, label), el('span', {}, String(value)));
}

function reviewItem(r) {
  return el('div', { class: 'card', style: 'margin-bottom:8px' },
    el('div', { class: 'row-between' },
      el('span', { class: 'stars' }, '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating)),
      el('span', { class: 'muted', style: 'font-size:0.8rem' }, fmtDate(r.reviewedAt)),
    ),
    r.comment ? el('p', { style: 'margin:8px 0 0' }, r.comment) : null,
  );
}

export async function render(container, params) {
  const gpuId = params.id;
  const root = el('div', { class: 'stack' }, skeleton('line', 6));
  container.appendChild(root);

  let gpu, reviewsRes, rateInfo;
  try {
    [gpu, reviewsRes, rateInfo] = await Promise.all([
      api.getGpu(gpuId).then((r) => r.gpu),
      api.getGpuReviews(gpuId, { limit: 20 }),
      getRate(),
    ]);
  } catch (err) {
    root.replaceChildren(emptyState('⚠️', 'GPUが見つかりません', err instanceof ApiError ? err.message : ''));
    return;
  }

  const price = priceLine(gpu.pricePerHour, rateInfo, '/時');
  const ratingText = reviewsRes.ratingAverage != null
    ? `★${reviewsRes.ratingAverage}（${reviewsRes.total}件のレビュー）`
    : 'まだレビューがありません';

  const rentBtn = el('button', {
    class: 'btn btn-primary',
    disabled: gpu.available === false,
    onClick: () => {
      if (!isAuthenticated()) { navigate(`#/login?next=gpus/${gpuId}`); return; }
      openRentModal(gpu, rateInfo);
    },
  }, gpu.available === false ? '貸出中' : 'このGPUを借りる');

  const specCard = el('div', { class: 'card stack' },
    specRow('ベンダー', gpu.vendor),
    specRow('モデル', gpu.model),
    specRow('APIタイプ', gpu.apiType),
    specRow('ドライババージョン', gpu.driverVersion),
    specRow('OS', gpu.os),
    specRow('アーキテクチャ', gpu.arch),
    specRow('メモリ', `${gpu.memoryGB} GB`),
    specRow('クロック', `${gpu.clockMHz} MHz`),
    specRow('消費電力', `${gpu.powerWatt} W`),
  );

  const reviewsSection = el('div', { class: 'stack' },
    el('h3', {}, `レビュー（${reviewsRes.total}件）`),
    reviewsRes.reviews.length
      ? el('div', {}, ...reviewsRes.reviews.map(reviewItem))
      : el('p', { class: 'muted' }, 'まだレビューがありません。'),
  );

  root.replaceChildren(
    el('div', { class: 'stack' },
      el('div', { class: 'section-title' },
        el('h1', {}, gpu.name),
        gpu.available === false ? el('span', { class: 'chip' }, '貸出中') : null,
      ),
      el('div', { class: 'chips' },
        el('span', { class: 'chip' }, gpu.vendor),
        el('span', { class: 'chip' }, gpu.apiType),
        el('span', { class: 'chip' }, `${gpu.memoryGB}GB`),
      ),
      el('p', { class: 'muted' }, ratingText),
      el('div', { class: 'row', style: 'gap:16px;align-items:baseline' },
        el('div', { style: 'font-size:1.4rem;font-weight:700' }, price.sats),
        price.jpy ? el('div', { class: 'muted' }, price.jpy) : null,
      ),
      rentBtn,
      el('h3', {}, 'スペック'),
      specCard,
      reviewsSection,
    )
  );
}
