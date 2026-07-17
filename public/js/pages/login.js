// public/js/pages/login.js
import { el } from '../ui.js';
import { ApiError } from '../api.js';
import { performLogin } from '../auth.js';
import { navigate } from '../router.js';
import { toast } from '../ui.js';

export function render(container, params, query) {
  const next = query.get('next');
  const emailInput = el('input', { type: 'email', id: 'login-email', required: true, autocomplete: 'email' });
  const pwdInput = el('input', { type: 'password', id: 'login-password', required: true, autocomplete: 'current-password' });
  const errorBox = el('p', { class: 'error-msg', style: 'display:none' });
  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'ログイン');

  const form = el('form', {
    class: 'stack',
    onSubmit: async (e) => {
      e.preventDefault();
      errorBox.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.textContent = 'ログイン中…';
      try {
        await performLogin(emailInput.value.trim(), pwdInput.value);
        toast('ログインしました', 'success');
        navigate(next ? `#/${next}` : '#/market');
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.message : '通信エラーが発生しました';
        errorBox.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'ログイン';
      }
    },
  },
    el('div', { class: 'field' },
      el('label', { for: 'login-email' }, 'メールアドレス'),
      emailInput
    ),
    el('div', { class: 'field' },
      el('label', { for: 'login-password' }, 'パスワード'),
      pwdInput
    ),
    errorBox,
    submitBtn,
  );

  container.appendChild(
    el('div', { class: 'form-card' },
      el('h1', {}, 'ログイン'),
      form,
      el('p', { class: 'switch-link' }, 'アカウントをお持ちでない方は ', el('a', { href: '#/register' }, '新規登録')),
    )
  );

  emailInput.focus();
}
