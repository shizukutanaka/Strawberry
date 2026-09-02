// public/js/ui.js — DOM building helpers, toasts, formatters, status maps.
// el() builds elements via properties/attributes, never innerHTML with
// user-controlled data — this is the XSS-hygiene backbone of the whole SPA.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value; // only for trusted static strings
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list') {
      try { node[key] = value; } catch (_) { node.setAttribute(key, value); }
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

let toastSeq = 0;
export function toast(message, kind = 'info', timeoutMs = 4000) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const id = `toast-${++toastSeq}`;
  const node = el('div', { class: `toast toast-${kind}`, id }, message);
  container.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, timeoutMs);
}

export function skeleton(kind = 'card', count = 3) {
  const wrap = el('div', { class: kind === 'card' ? 'grid' : 'stack' });
  for (let i = 0; i < count; i++) {
    if (kind === 'card') {
      wrap.appendChild(el('div', { class: 'skeleton skeleton-card' }));
    } else {
      wrap.appendChild(el('div', { class: 'skeleton skeleton-line', style: `width:${60 + (i % 3) * 15}%` }));
    }
  }
  return wrap;
}

export function emptyState(icon, title, hint, cta) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'icon' }, icon),
    el('h3', {}, title),
    hint ? el('p', { class: 'muted' }, hint) : null,
    cta || null
  );
}

const STATUS_LABELS = {
  pending: '承認待ち',
  matched: '承認済み・決済待ち',
  active: '稼働中',
  preempting: '中断通知中',
  completed: '完了',
  cancelled: 'キャンセル',
  disputed: '係争中',
};
const STATUS_ORDER = ['pending', 'matched', 'active', 'completed'];

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

export function statusBadge(status) {
  return el('span', { class: `badge badge-${status}` }, statusLabel(status));
}

// プロバイダー信頼性バッジ。reliability = { score, tier, sessions, measuring } を受け取り、
// 未計測（score=null）は控えめな「計測中」チップ、計測済みは色分けした % 表示を返す。
// 正直なUI原則: サンプル不足のスコアを断定的に見せない。
const RELIABILITY_TIER_LABELS = {
  excellent: '非常に安定', good: '安定', fair: 'やや不安定', poor: '不安定',
  measuring: '計測中', unrated: '実績なし', unknown: '',
};
export function reliabilityBadge(reliability) {
  if (!reliability) return null;
  const { score, tier, sessions } = reliability;
  if (score == null) {
    // measuring / unrated / 実績なし
    const label = tier === 'measuring' ? '稼働計測中' : '稼働実績なし';
    return el('span', { class: 'chip chip-reliability chip-reliability-unrated', title: '安定稼働の実績が十分に蓄積されていません' }, label);
  }
  const pct = Math.round(score * 100);
  const tierLabel = RELIABILITY_TIER_LABELS[tier] || '';
  const title = `稼働安定度 ${pct}%${sessions ? `（${sessions}セッションの実績）` : ''}`;
  return el('span', { class: `chip chip-reliability chip-reliability-${tier}`, title }, `稼働 ${pct}%${tierLabel ? ` ・ ${tierLabel}` : ''}`);
}

// GPUスペック検証ティアバッジ。attestation = { passed, score, findings, verifiedAt } を受け取る。
// 正直なUI原則: プロバイダー申告スペックは詐称され得る（vBIOS書き換え等）ため、
// 表示は attestation.trustLevel から決める。**passed だけで「検証済み」と言ってはいけない。**
// レポートはプロバイダーが自分で送ってくるもので、署名の出所を確かめる仕組みは
// まだ無い（src/security/gpu-attestation-verifier.js のヘッダ参照）。以前ここは
// passed を「実測検証済み」「実機で確認済み」と表示していたため、
// プロバイダーは自分で書いたレポートを添えるだけでそのバッジを買えた。
export function attestationBadge(attestation) {
  if (!attestation || !attestation.verifiedAt) {
    return el('span', { class: 'chip chip-attestation chip-attestation-self', title: 'プロバイダーの自己申告スペックです。照合レポートの提出もありません。' }, 'スペック: 自己申告');
  }
  if (attestation.passed) {
    // 旧データには trustLevel が無い。無い＝第三者検証ではない、と安全側に倒す。
    if (attestation.trustLevel === 'hardware_attested') {
      return el('span', { class: 'chip chip-attestation chip-attestation-verified', title: `ベンダーの信頼の根まで署名を検証済み（スコア ${Math.round((attestation.score || 0) * 100)}%）` }, 'スペック: 第三者検証済み');
    }
    return el('span', { class: 'chip chip-attestation chip-attestation-selfreport', title: `プロバイダー提出のレポートが申告スペックと一致し、期限内であることを確認しました（スコア ${Math.round((attestation.score || 0) * 100)}%）。レポート自体はプロバイダーが作るもので、第三者による実機検証ではありません。` }, 'スペック: 自己申告（照合済み）');
  }
  const findings = Array.isArray(attestation.findings) ? attestation.findings.join('; ') : '';
  return el('span', { class: 'chip chip-attestation chip-attestation-failed', title: `提出レポートと申告スペックの不一致が検出されました: ${findings}` }, 'スペック: 申告に不一致');
}

// 正規化性能スコアのバッジ。performanceScore = { score, confidence, matchedModel, perfPerHourSat }。
// 正直なUI原則:
//   - スコアは「順位付けの指数（参照GPU=RTX 4090 級を 100）」であって実測スループットでは
//     ないことをツールチップで明示する。
//   - 根拠の強さ（実機検証済み / 型番既知 / 自己申告）を必ず区別し、算出できない場合は
//     推測値を出さず「未算出」と表示する（reliability の「計測中」と同じ扱い）。
const PERF_CONFIDENCE = {
  attested: { label: '第三者検証済み', cls: 'verified', hint: 'ベンダーの信頼の根まで検証されたアテステーションで、申告スペックが実機と一致することを確認済み' },
  reference: { label: '型番既知', cls: 'reference', hint: '型番が既知GPUの公開スペックと一致（実機検証は未実施）' },
  declared: { label: '自己申告', cls: 'declared', hint: 'プロバイダーの自己申告スペックのみに基づく推定値' },
};
export function perfBadge(performanceScore) {
  if (!performanceScore) return null;
  const { score, confidence } = performanceScore;
  if (score == null) {
    return el('span', {
      class: 'chip chip-perf chip-perf-unknown',
      title: '型番が参照表に無く、性能の根拠となる申告値も無いためスコアを算出していません',
    }, '性能: 未算出');
  }
  const meta = PERF_CONFIDENCE[confidence] || PERF_CONFIDENCE.declared;
  const title = `性能スコア ${score}（RTX 4090 級 = 100 の相対指数。実測スループットではありません）／根拠: ${meta.hint}`;
  return el('span', { class: `chip chip-perf chip-perf-${meta.cls}`, title }, `性能 ${score} ・ ${meta.label}`);
}

// 価格対性能（1 sats/時 あたりの性能スコア）。数値が大きいほど割安。
export function valueBadge(performanceScore) {
  if (!performanceScore || performanceScore.perfPerHourSat == null) return null;
  const v = performanceScore.perfPerHourSat;
  return el('span', {
    class: 'chip chip-perf chip-perf-value',
    title: '価格対性能 = 性能スコア ÷ 時間単価(sats)。同じ予算でより多くの計算が回せるほど大きくなります',
  }, `コスパ ${v >= 0.01 ? v.toFixed(3) : v.toExponential(1)}/sat`);
}

// Spot（中断許容）ティアのバッジ。gpu.spot = { enabled, discountPct, noticeSeconds, pricePerHour }。
// 正直なUI原則: 割引率だけを大きく見せて中断リスクを小さく書かない。「%引き」と
// 「中断あり」を同じチップに並べ、猶予秒数をツールチップで必ず示す。
export function spotBadge(spot) {
  if (!spot || !spot.enabled) return null;
  const title = `中断許容ティア: 定価より${spot.discountPct}%安く借りられますが、提供者の都合で中断されることがあります。`
    + `中断通知から停止までの猶予は${spot.noticeSeconds}秒で、課金は実際に提供された時間分のみです。`;
  return el('span', { class: 'chip chip-spot', title }, `中断許容 -${spot.discountPct}%`);
}

// カーボン強度バッジ。carbon = { gCO2PerKWh, tier, gramsPerHour, confidence, matched }。
// 正直なUI原則: **所在地は自己申告で未検証**なので、これは環境認証ではなく「申告地の系統
// 平均に基づく推定」だと必ず断る。グリーンウォッシングがこの機能の失敗モードであり、
// 検証済みの環境価値であるかのように見せてはならない。不明な地域は推測せず「不明」と出す。
const CARBON_TIER_LABELS = {
  very_low: '非常に低炭素', low: '低炭素', moderate: '中程度', high: '高炭素', very_high: '非常に高炭素',
};
export function carbonBadge(carbon) {
  if (!carbon) return null;
  if (carbon.gCO2PerKWh == null) {
    return el('span', {
      class: 'chip chip-carbon chip-carbon-unknown',
      title: '所在地が未申告、または系統カーボン強度の参照データが無い地域です。推測値は表示しません。',
    }, '炭素: 不明');
  }
  const label = CARBON_TIER_LABELS[carbon.tier] || '';
  const title = `申告された所在地(${carbon.matched})の系統カーボン強度 約${carbon.gCO2PerKWh} gCO2eq/kWh に基づく推定です。`
    + `この GPU を1時間動かすと約 ${Math.round(carbon.gramsPerHour)} gCO2eq（PUE ${carbon.pue} を含む）。`
    + '所在地はプロバイダーの自己申告で未検証、かつ年間平均であって実時間の値ではありません。';
  return el('span', { class: `chip chip-carbon chip-carbon-${carbon.tier}`, title },
    `${label} ${Math.round(carbon.gramsPerHour)}g/時`);
}

export function timeline(order) {
  const current = order.status;
  const list = el('ul', { class: 'timeline' });
  const steps = STATUS_ORDER;
  const isTerminalAlt = current === 'cancelled' || current === 'disputed';
  // preempting は STATUS_ORDER に無い中間状態だが、稼働中であることに変わりはない。
  // そのまま indexOf すると -1 になり、どの段階もハイライトされない空のタイムラインになる。
  const currentIdx = steps.indexOf(current === 'preempting' ? 'active' : current);
  steps.forEach((step, idx) => {
    const li = el('li', {}, statusLabel(step));
    if (!isTerminalAlt && idx < currentIdx) li.classList.add('done');
    else if (!isTerminalAlt && idx === currentIdx) li.classList.add('current');
    list.appendChild(li);
  });
  if (isTerminalAlt) {
    list.appendChild(el('li', { class: 'current' }, statusLabel(current)));
  }
  return list;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtSats(n) {
  if (n == null || isNaN(n)) return '—';
  return `${Math.round(n).toLocaleString('ja-JP')} sats`;
}

export function fmtJpy(n) {
  if (n == null || isNaN(n)) return '—';
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}

export function fieldError(input, msg) {
  input.classList.toggle('invalid', !!msg);
  const wrap = input.closest('.field');
  if (!wrap) return;
  let node = wrap.querySelector('.error-msg');
  if (msg) {
    if (!node) {
      node = el('div', { class: 'error-msg' });
      wrap.appendChild(node);
    }
    node.textContent = msg;
  } else if (node) {
    node.remove();
  }
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' },
      el('h3', {}, '確認'),
      el('p', {}, message),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn btn-ghost', onClick: () => { backdrop.remove(); resolve(false); } }, 'キャンセル'),
        el('button', {
          class: 'btn btn-danger', onClick: () => { backdrop.remove(); resolve(true); },
        }, '実行'),
      )
    );
    backdrop.appendChild(modal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(false); } });
    document.body.appendChild(backdrop);
  });
}
