// public/js/pages/account.js — account settings (password change).
// The backend has had PUT /users/me/password (with full session invalidation
// on success) since early on, but there was no UI to reach it — an
// authenticated user had no way to change their password. Because a successful
// change revokes ALL sessions (including the token this request used), the flow
// deliberately clears the local session and sends the user back to login.
import { el, fieldError, toast } from '../ui.js';
import { api, ApiError } from '../api.js';
import { clearSession, getUser } from '../auth.js';
import { navigate } from '../router.js';

// Mirrors register.js's PWD_RULES (client-side UX only; the server Joi schema in
// routes/user/index.js PUT /me/password remains the source of truth). Kept in
// sync by hand rather than shared to avoid refactoring the working register page.
const PWD_RULES = [
  { key: 'len', label: '8〜72文字', test: (v) => v.length >= 8 && v.length <= 72 },
  { key: 'lower', label: '小文字を含む', test: (v) => /[a-z]/.test(v) },
  { key: 'upper', label: '大文字を含む', test: (v) => /[A-Z]/.test(v) },
  { key: 'digit', label: '数字を含む', test: (v) => /[0-9]/.test(v) },
  { key: 'symbol', label: '記号を含む', test: (v) => /[^a-zA-Z0-9]/.test(v) },
];

export function render(container) {
  const user = getUser();

  const currentInput = el('input', { type: 'password', id: 'acc-current', required: true, autocomplete: 'current-password' });
  const newInput = el('input', { type: 'password', id: 'acc-new', required: true, autocomplete: 'new-password' });
  const confirmInput = el('input', { type: 'password', id: 'acc-confirm', required: true, autocomplete: 'new-password' });
  const errorBox = el('p', { class: 'error-msg', style: 'display:none' });
  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, 'パスワードを変更');

  const checklist = el('ul', { class: 'pwd-checklist' },
    ...PWD_RULES.map((r) => el('li', { 'data-key': r.key }, el('span', { class: 'mark' }, '○'), r.label)));

  newInput.addEventListener('input', () => {
    const v = newInput.value;
    PWD_RULES.forEach((r) => {
      const li = checklist.querySelector(`li[data-key="${r.key}"]`);
      const ok = r.test(v);
      li.classList.toggle('ok', ok);
      li.querySelector('.mark').textContent = ok ? '✓' : '○';
    });
  });

  function validateClientSide() {
    let ok = true;
    if (!currentInput.value) { fieldError(currentInput, '現在のパスワードを入力してください'); ok = false; } else fieldError(currentInput, '');
    if (!PWD_RULES.every((r) => r.test(newInput.value))) { fieldError(newInput, 'パスワード要件を満たしていません'); ok = false; } else fieldError(newInput, '');
    if (confirmInput.value !== newInput.value) { fieldError(confirmInput, 'パスワードが一致しません'); ok = false; } else fieldError(confirmInput, '');
    if (ok && currentInput.value === newInput.value) { fieldError(newInput, '新しいパスワードは現在のものと異なる必要があります'); ok = false; }
    return ok;
  }

  const form = el('form', {
    class: 'stack',
    onSubmit: async (e) => {
      e.preventDefault();
      errorBox.style.display = 'none';
      if (!validateClientSide()) return;
      submitBtn.disabled = true;
      submitBtn.textContent = '変更中…';
      try {
        await api.changePassword(currentInput.value, newInput.value);
        // 成功時は全セッション（このトークン含む）が失効するため、ローカルセッションを
        // 破棄してログインへ戻す。残したままだと次の API 呼び出しが 401 になる。
        clearSession();
        toast('パスワードを変更しました。再度ログインしてください', 'success');
        navigate('#/login');
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.message : '通信エラーが発生しました';
        errorBox.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'パスワードを変更';
      }
    },
  },
    el('div', { class: 'field' }, el('label', { for: 'acc-current' }, '現在のパスワード'), currentInput),
    el('div', { class: 'field' }, el('label', { for: 'acc-new' }, '新しいパスワード'), newInput, checklist),
    el('div', { class: 'field' }, el('label', { for: 'acc-confirm' }, '新しいパスワード（確認）'), confirmInput),
    errorBox,
    submitBtn,
  );

  container.appendChild(
    el('div', { class: 'stack', style: 'max-width:480px' },
      el('h1', {}, 'アカウント設定'),
      user ? el('p', { class: 'muted' }, `${user.username || user.email || ''}（${user.role || 'renter'}）`) : null,
      el('div', { class: 'card stack' },
        el('h3', { style: 'margin:0' }, 'パスワード変更'),
        el('p', { class: 'muted', style: 'font-size:0.85rem;margin:0' }, 'パスワードを変更すると、すべての端末のセッションからログアウトされます。'),
        form,
      ),
    )
  );
}
