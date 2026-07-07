// public/js/pages/register.js — mirrors server Joi rules for immediate feedback,
// but the server remains the source of truth (client validation is UX only).
import { el, fieldError, toast } from '../ui.js';
import { api, ApiError } from '../api.js';
import { performLogin } from '../auth.js';
import { navigate } from '../router.js';

const PWD_RULES = [
  { key: 'len', label: '8〜72文字', test: (v) => v.length >= 8 && v.length <= 72 },
  { key: 'lower', label: '小文字を含む', test: (v) => /[a-z]/.test(v) },
  { key: 'upper', label: '大文字を含む', test: (v) => /[A-Z]/.test(v) },
  { key: 'digit', label: '数字を含む', test: (v) => /[0-9]/.test(v) },
  { key: 'symbol', label: '記号を含む', test: (v) => /[^a-zA-Z0-9]/.test(v) },
];

export function render(container) {
  const usernameInput = el('input', { type: 'text', id: 'reg-username', required: true, autocomplete: 'username', pattern: '[A-Za-z0-9]{3,30}' });
  const emailInput = el('input', { type: 'email', id: 'reg-email', required: true, autocomplete: 'email' });
  const pwdInput = el('input', { type: 'password', id: 'reg-password', required: true, autocomplete: 'new-password' });
  const pwdConfirmInput = el('input', { type: 'password', id: 'reg-password-confirm', required: true, autocomplete: 'new-password' });
  const providerCheckbox = el('input', { type: 'checkbox', id: 'reg-provider' });
  const errorBox = el('p', { class: 'error-msg', style: 'display:none' });
  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, '登録する');

  const checklist = el('ul', { class: 'pwd-checklist' },
    ...PWD_RULES.map((r) => el('li', { 'data-key': r.key }, el('span', { class: 'mark' }, '○'), r.label))
  );

  pwdInput.addEventListener('input', () => {
    const v = pwdInput.value;
    PWD_RULES.forEach((r) => {
      const li = checklist.querySelector(`li[data-key="${r.key}"]`);
      const ok = r.test(v);
      li.classList.toggle('ok', ok);
      li.querySelector('.mark').textContent = ok ? '✓' : '○';
    });
  });

  function validateClientSide() {
    let ok = true;
    if (!/^[A-Za-z0-9]{3,30}$/.test(usernameInput.value)) {
      fieldError(usernameInput, 'ユーザー名は英数字3〜30文字で入力してください');
      ok = false;
    } else fieldError(usernameInput, '');

    if (!PWD_RULES.every((r) => r.test(pwdInput.value))) {
      fieldError(pwdInput, 'パスワード要件を満たしていません');
      ok = false;
    } else fieldError(pwdInput, '');

    if (pwdConfirmInput.value !== pwdInput.value) {
      fieldError(pwdConfirmInput, 'パスワードが一致しません');
      ok = false;
    } else fieldError(pwdConfirmInput, '');

    return ok;
  }

  const form = el('form', {
    class: 'stack',
    onSubmit: async (e) => {
      e.preventDefault();
      errorBox.style.display = 'none';
      if (!validateClientSide()) return;
      submitBtn.disabled = true;
      submitBtn.textContent = '登録中…';
      try {
        const role = providerCheckbox.checked ? 'provider' : undefined;
        await api.register(usernameInput.value.trim(), emailInput.value.trim(), pwdInput.value, role);
        await performLogin(emailInput.value.trim(), pwdInput.value);
        toast('登録が完了しました', 'success');
        navigate('#/market');
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.message : '通信エラーが発生しました';
        errorBox.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '登録する';
      }
    },
  },
    el('div', { class: 'field' },
      el('label', { for: 'reg-username' }, 'ユーザー名'),
      usernameInput,
      el('div', { class: 'hint' }, '英数字3〜30文字'),
    ),
    el('div', { class: 'field' },
      el('label', { for: 'reg-email' }, 'メールアドレス'),
      emailInput,
    ),
    el('div', { class: 'field' },
      el('label', { for: 'reg-password' }, 'パスワード'),
      pwdInput,
      checklist,
    ),
    el('div', { class: 'field' },
      el('label', { for: 'reg-password-confirm' }, 'パスワード（確認）'),
      pwdConfirmInput,
    ),
    el('div', { class: 'field checkbox-field' },
      providerCheckbox,
      el('label', { for: 'reg-provider' }, 'プロバイダーとして登録する（GPUを貸し出す）'),
    ),
    errorBox,
    submitBtn,
  );

  container.appendChild(
    el('div', { class: 'form-card' },
      el('h1', {}, '新規登録'),
      form,
      el('p', { class: 'switch-link' }, 'すでにアカウントをお持ちの方は ', el('a', { href: '#/login' }, 'ログイン')),
    )
  );

  usernameInput.focus();
}
