// public/js/pages/gpu-detail.js — full GPU spec + reviews, with a rent CTA.
// Reached by clicking a GPU name/rating in market.js's cards (previously
// there was no way to see full specs or read individual reviews before
// deciding to rent — market.js's cards only ever showed a summary).
import { el, skeleton, emptyState, toast, fmtDate, fmtSats, reliabilityBadge, attestationBadge, perfBadge, valueBadge, spotBadge, carbonBadge } from '../ui.js';
import { api, ApiError } from '../api.js';
import { getRateWithin, priceLine } from '../rate.js';
import { isAuthenticated } from '../auth.js';
import { navigate } from '../router.js';
import { openRentModal } from '../rent-modal.js';

// 値が無いときに空欄や 0 を出さない。「未申告」と「0 W」は別のことで、
// 後者は誤った断定になる。導出値は「推定」と明示して申告値と区別する。
function specRow(label, value, { derived = false, unit = '' } = {}) {
  const missing = value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value));
  return el('div', { class: 'row-between spec-row', style: 'padding:4px 0;border-bottom:1px solid var(--color-border)' },
    el('span', { class: 'muted' }, label),
    missing
      ? el('span', { class: 'muted' }, '未申告')
      : el('span', {},
          `${value}${unit}`,
          derived ? el('span', { class: 'chip chip-derived', style: 'margin-left:6px' }, '推定') : null),
  );
}

// 出品者の信頼度。誰から借りるかは何を借りるかと同じくらい重い判断なのに、
// 以前はレビューの平均★しか見えず、完了/拒否の実績・評判スコアは API の奥に
// 眠っていた（/users/:id/reputation は UI から到達できなかった）。
function trustCard(rep) {
  if (!rep) return null;
  const rating = rep.ratingAverage != null
    ? `★${rep.ratingAverage}（${rep.reviewCount}件）`
    : 'レビューなし';
  return el('div', { class: 'card stack trust-card' },
    el('div', { class: 'chips' },
      el('span', { class: 'chip' }, `評判 ${rep.tier}`),
      el('span', { class: 'chip' }, `スコア ${Math.round(rep.score)}`),
    ),
    specRow('借り手からの評価', rating),
    specRow('取引完了', `${rep.completedOrders} 件`),
    specRow('注文を拒否', `${rep.rejectedOrders} 件`),
    rep.stats && rep.stats.slashCount ? specRow('ペナルティ（係争敗訴など）', `${rep.stats.slashCount} 回`) : null,
    rep.memberSince ? specRow('出品者登録', fmtDate(rep.memberSince)) : null,
  );
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
      // 円換算は表示上のおまけ。外部の為替 API が遅い／落ちているときに
      // ページ全体の描画を止めないよう、待ち時間に上限を設ける。
      getRateWithin(),
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

  // 出品者が申告しなかったためサーバが機種から補った項目（src/gpu/listing-defaults.js）
  const derivedSet = new Set(Array.isArray(gpu.derivedFields) ? gpu.derivedFields : []);
  const isDerived = (f) => derivedSet.has(f);
  const specCard = el('div', { class: 'card stack spec-card' },
    attestationBadge(gpu.attestation),
    specRow('ベンダー', gpu.vendor),
    specRow('モデル', gpu.model),
    specRow('APIタイプ', gpu.apiType, { derived: isDerived('apiType') }),
    specRow('ドライババージョン', gpu.driverVersion),
    specRow('OS', gpu.os),
    specRow('アーキテクチャ', gpu.arch, { derived: isDerived('arch') }),
    specRow('メモリ', gpu.memoryGB, { unit: ' GB' }),
    specRow('クロック', gpu.clockMHz, { unit: ' MHz' }),
    specRow('消費電力', gpu.powerWatt, { unit: ' W', derived: isDerived('powerWatt') }),
  );

  // 性能スコアの内訳。一覧のバッジだけでは「なぜこのスコアなのか」が分からないため、
  // 詳細ページでは算出根拠（basis）と申告矛盾（findings）まで開示する。
  const perf = gpu.performanceScore;
  const perfCard = perf ? el('div', { class: 'card stack perf-card' },
    el('div', { class: 'chips' }, perfBadge(perf), valueBadge(perf)),
    el('p', { class: 'muted', style: 'font-size:0.85rem;margin:0' },
      'RTX 4090 級を 100 とした機種横断の相対指数です。演算性能・メモリ帯域・VRAM 容量の加重幾何平均で、実測スループットの予測値ではありません。'),
    perf.matchedModel ? specRow('照合された型番', perf.matchedModel) : null,
    perf.basis && perf.basis.fp16Tflops != null ? specRow('演算性能(FP16)', `約 ${perf.basis.fp16Tflops} TFLOPS`) : null,
    perf.basis && perf.basis.memBandwidthGBs != null ? specRow('メモリ帯域', `約 ${perf.basis.memBandwidthGBs} GB/s`) : null,
    perf.basis ? specRow('根拠', perf.basis.source) : null,
    // 申告矛盾は借り手が知るべき警告 — 目立つ形で開示し、黙って握り潰さない。
    perf.findings && perf.findings.length
      ? el('div', { class: 'stack', style: 'gap:4px' },
          el('strong', { style: 'color:var(--color-danger)' }, '申告スペックに関する注意'),
          el('ul', { style: 'margin:0;padding-left:1.2em' },
            ...perf.findings.map((f) => el('li', { class: 'muted', style: 'font-size:0.85rem' }, f))))
      : null,
  ) : null;

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
        gpu.apiType ? el('span', { class: 'chip' }, gpu.apiType) : null,
        el('span', { class: 'chip' }, `${gpu.memoryGB}GB`),
        reliabilityBadge(gpu.reliability),
        spotBadge(gpu.spot),
        carbonBadge(gpu.carbon),
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
      gpu.providerReputation ? el('h3', {}, '出品者の信頼度') : null,
      trustCard(gpu.providerReputation),
      el('h3', {}, '価格通知'),
      renderWatchSection(gpuId, gpu),
      perfCard ? el('h3', {}, '性能スコア') : null,
      perfCard,
      el('h3', {}, 'スペック'),
      specCard,
      reviewsSection,
    )
  );
}
