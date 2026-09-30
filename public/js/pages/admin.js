// public/js/pages/admin.js — admin dashboard: marketplace stats, verification
// audit results, escrow states, and ops actions (expiry sweep, cache purge).
// Backed entirely by the existing /api/v1/admin/* endpoints.
import { el, skeleton, emptyState, toast, fmtDate, fmtSats, fmtJpy, confirmDialog, statusLabel } from '../ui.js';
import { api, ApiError } from '../api.js';
import { navigate } from '../router.js';

const VERDICT_LABELS = {
  verified: '検証OK',
  failed: '失敗',
  inconclusive: '不確定',
  pending: '保留',
};

function statCard(title, big, sub) {
  return el('div', { class: 'card' },
    el('div', { class: 'muted', style: 'font-size:0.85rem' }, title),
    el('div', { style: 'font-size:1.6rem;font-weight:600' }, big),
    sub ? el('div', { class: 'muted', style: 'font-size:0.8rem' }, sub) : null,
  );
}

function renderStats(box, stats) {
  const { users, gpus, orders, gmv } = stats;
  const roleText = Object.entries(users.byRole || {}).map(([r, n]) => `${r}: ${n}`).join(' / ') || '—';
  const statusText = Object.entries(orders.byStatus || {})
    .map(([s, n]) => `${statusLabel(s)}: ${n}`).join(' / ') || '—';
  box.replaceChildren(
    el('div', { class: 'grid' },
      statCard('ユーザー', String(users.total), roleText),
      statCard('GPU', String(gpus.total), `空き ${gpus.available} / 占有 ${gpus.occupied}`),
      statCard('注文', String(orders.total), statusText),
      statCard('累計GMV（完了注文）', fmtSats(gmv.completedSats), fmtJpy(gmv.completedJPY)),
    )
  );
}

function verificationRow(v) {
  return el('tr', {},
    el('td', { 'data-label': 'ジョブ', class: 'mono' }, (v.jobId || '').slice(0, 12) || '—'),
    el('td', { 'data-label': 'プロバイダ', class: 'mono' }, (v.providerId || '').slice(0, 8) || '—'),
    el('td', { 'data-label': '監査' }, v.audited ? '対象' : '対象外'),
    el('td', { 'data-label': '判定' }, VERDICT_LABELS[v.verdict] || v.verdict || '—'),
    el('td', { 'data-label': 'ゼロ負荷疑い' }, v.suspectedZeroLoad ? 'あり' : '—'),
    el('td', { 'data-label': '記録日時' }, fmtDate(v.createdAt)),
  );
}

function escrowRow(e) {
  return el('tr', {},
    el('td', {
      'data-label': '注文', class: 'mono', style: 'cursor:pointer;color:var(--color-primary)',
      onClick: () => e.orderId && navigate(`#/orders/${e.orderId}`),
    }, (e.orderId || '').slice(0, 8) || '—'),
    el('td', { 'data-label': '状態' }, e.state || '—'),
    el('td', { 'data-label': '金額' }, fmtSats(e.amountSats ?? e.amount)),
    el('td', { 'data-label': '作成日時' }, fmtDate(e.createdAt)),
  );
}

export async function render(container) {
  const statsBox = el('div', {}, skeleton('card', 4));
  const verBox = el('div', { class: 'table-wrap' }, skeleton('line', 4));
  const escrowBox = el('div', { class: 'table-wrap' }, skeleton('line', 4));
  const escrowFilter = el('select', {},
    el('option', { value: '' }, 'すべて'),
    ...['PENDING', 'HELD', 'SETTLED', 'CANCELED', 'DISPUTED'].map((s) => el('option', { value: s }, s)),
  );
  escrowFilter.addEventListener('change', loadEscrow);

  async function expireSweep() {
    const ok = await confirmDialog('期限切れ注文のスイープを実行しますか？（pending/matched/disputed/active 全対象）');
    if (!ok) return;
    try {
      const res = await api.adminExpireOrders();
      const detail = Object.entries(res)
        .filter(([k]) => k !== 'timestamp')
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : v}`)
        .join(', ');
      toast(`スイープ完了（${detail || '対象なし'}）`, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'スイープに失敗しました', 'error');
    }
  }

  async function purgeCache() {
    const ok = await confirmDialog('API レスポンスキャッシュを全パージしますか？');
    if (!ok) return;
    try {
      await api.adminCachePurge();
      toast('キャッシュをパージしました', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'パージに失敗しました', 'error');
    }
  }

  async function loadEscrow() {
    escrowBox.replaceChildren(skeleton('line', 4));
    try {
      const res = await api.adminEscrow({ state: escrowFilter.value || undefined, limit: 50 });
      if (!res.escrows.length) {
        escrowBox.replaceChildren(emptyState('📭', 'エスクローはありません', ''));
        return;
      }
      escrowBox.replaceChildren(el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {},
          el('th', {}, '注文'), el('th', {}, '状態'), el('th', {}, '金額'), el('th', {}, '作成日時'))),
        el('tbody', {}, ...res.escrows.map(escrowRow)),
      ));
    } catch (err) {
      escrowBox.replaceChildren(emptyState('⚠️', '取得に失敗しました', err instanceof ApiError ? err.message : ''));
    }
  }

  container.appendChild(
    el('div', { class: 'stack' },
      el('div', { class: 'row-between' },
        el('h1', {}, '管理ダッシュボード'),
        el('div', { class: 'row' },
          el('button', { class: 'btn btn-ghost btn-sm', onClick: expireSweep }, '期限切れスイープ'),
          el('button', { class: 'btn btn-ghost btn-sm', onClick: purgeCache }, 'キャッシュパージ'),
        ),
      ),
      statsBox,
      el('h2', {}, '検証監査（最新50件）'),
      verBox,
      el('div', { class: 'row-between' },
        el('h2', {}, 'エスクロー'),
        el('label', { class: 'row muted', style: 'gap:6px;font-size:0.85rem' }, '状態:', escrowFilter),
      ),
      escrowBox,
    )
  );

  // 統計と検証一覧は並行取得。個別失敗はそのカード内に閉じ込める。
  api.adminStats()
    .then((s) => renderStats(statsBox, s))
    .catch((err) => statsBox.replaceChildren(
      emptyState('⚠️', '統計の取得に失敗しました', err instanceof ApiError ? err.message : '')));
  api.adminVerifications({ limit: 50 })
    .then((res) => {
      if (!res.records.length) {
        verBox.replaceChildren(emptyState('🔍', '検証レコードはありません', ''));
        return;
      }
      verBox.replaceChildren(el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'ジョブ'), el('th', {}, 'プロバイダ'), el('th', {}, '監査'),
          el('th', {}, '判定'), el('th', {}, 'ゼロ負荷疑い'), el('th', {}, '記録日時'))),
        el('tbody', {}, ...res.records.map(verificationRow)),
      ));
    })
    .catch((err) => verBox.replaceChildren(
      emptyState('⚠️', '取得に失敗しました', err instanceof ApiError ? err.message : '')));
  await loadEscrow();
}
