// public/js/pages/gpu-detail.js — full GPU spec + reviews, with a rent CTA.
// Reached by clicking a GPU name/rating in market.js's cards (previously
// there was no way to see full specs or read individual reviews before
// deciding to rent — market.js's cards only ever showed a summary).
import { el, skeleton, emptyState, toast, fmtDate, fmtSats, reliabilityBadge, attestationBadge } from '../ui.js';
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

// 価格ウォッチ（値下げ通知）セクション。GET/POST/DELETE /gpus/:id/watch は既存だが
// フロントエンドからの利用経路が皆無だった。ウォッチ一覧の集約エンドポイントは
// 存在しない（"自分のウォッチ全部" は取得できない）ため、GPU単位のトグルのみ提供する
// （専用の「ウォッチリスト」ページは今回のスコープ外）。
function renderWatchSection(gpuId, gpu) {
  const box = el('div', { class: 'card' }, el('p', { class: 'muted' }, '読み込み中…'));

  async function load() {
    if (!isAuthenticated()) {
      box.replaceChildren(el('p', { class: 'muted' }, 'ログインすると値下げ通知を設定できます。'));
      return;
    }
    try {
      const { watch } = await api.getGpuWatch(gpuId);
      renderActive(watch);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) renderInactive();
      else box.replaceChildren(el('p', { class: 'muted' }, '通知設定の取得に失敗しました。'));
    }
  }

  function renderInactive() {
    const priceInput = el('input', { type: 'number', min: '0.00001', step: 'any', placeholder: `例: ${Math.max(1, Math.round(gpu.pricePerHour * 0.8))}` });
    const setBtn = el('button', {
      class: 'btn btn-primary btn-sm',
      onClick: async () => {
        const v = parseFloat(priceInput.value);
        if (!Number.isFinite(v) || v <= 0) { toast('目標価格を入力してください', 'error'); return; }
        setBtn.disabled = true;
        try {
          await api.setGpuWatch(gpuId, v);
          toast('値下げ通知を設定しました', 'success');
          await load();
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '設定に失敗しました', 'error');
          setBtn.disabled = false;
        }
      },
    }, '通知を設定');
    box.replaceChildren(el('div', { class: 'stack' },
      el('p', {}, `このGPUの価格が指定額以下になったら通知します（現在: ${fmtSats(gpu.pricePerHour)}/時）`),
      el('div', { class: 'row' }, priceInput, setBtn),
    ));
  }

  function renderActive(watch) {
    const removeBtn = el('button', {
      class: 'btn btn-ghost btn-sm',
      onClick: async () => {
        removeBtn.disabled = true;
        try {
          await api.removeGpuWatch(gpuId);
          toast('通知を解除しました', 'info');
          await load();
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '解除に失敗しました', 'error');
          removeBtn.disabled = false;
        }
      },
    }, '通知を解除');
    box.replaceChildren(el('div', { class: 'row-between' },
      el('p', { style: 'margin:0' }, `目標価格 ${fmtSats(watch.targetPrice)}/時 以下で通知します`),
      removeBtn,
    ));
  }

  load();
  return box;
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
  // 相場統計は補助情報のため、取得に失敗しても詳細ページ全体は表示する。
  const marketRate = await api.getGpuMarketRate(gpuId).catch(() => null);

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
    attestationBadge(gpu.attestation),
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
        reliabilityBadge(gpu.reliability),
      ),
      el('p', { class: 'muted' }, ratingText),
      el('div', { class: 'row', style: 'gap:16px;align-items:baseline' },
        el('div', { style: 'font-size:1.4rem;font-weight:700' }, price.sats),
        price.jpy ? el('div', { class: 'muted' }, price.jpy) : null,
      ),
      // 相場統計は同機種のリスティングが2件以上ある時のみ表示する。1件（自分自身）
      // だけでは「相場」として意味を持たず、誤解を招く。
      marketRate && marketRate.sampleCount > 1
        ? el('p', { class: 'muted', style: 'font-size:0.85rem' },
            `相場（同機種 ${marketRate.sampleCount}件）: 中央値 ${fmtSats(marketRate.medianPricePerHour)}/時（${fmtSats(marketRate.minPricePerHour)}〜${fmtSats(marketRate.maxPricePerHour)}）`)
        : null,
      rentBtn,
      el('h3', {}, '価格通知'),
      renderWatchSection(gpuId, gpu),
      el('h3', {}, 'スペック'),
      specCard,
      reviewsSection,
    )
  );
}
