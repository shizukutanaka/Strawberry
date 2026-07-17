import { el, emptyState } from '../ui.js';

export function render(container) {
  container.appendChild(
    emptyState('🔍', 'ページが見つかりません', 'URLをご確認ください。',
      el('a', { href: '#/market', class: 'btn btn-primary' }, 'マーケットへ戻る'))
  );
}
