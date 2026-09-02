// public/js/pages/account.js — アカウント設定。
//
// パスワード変更・通知先・値下げ通知中の GPU の 3 つ。いずれも API は以前から
// あった（PUT /users/me/password、/notification-settings/:userId、GET /users/me/watches）
// が、呼ぶ画面が無かった。特に通知先は、貸し手に「注文が入った」を届ける唯一の
// 経路なのに登録手段が無く、製品内では貸し手への通知が一度も発火していなかった。
import { el, skeleton, toast, fieldError, confirmDialog, fmtSats, fmtDate } from '../ui.js';
import { api, ApiError } from '../api.js';
import { getUser, clearSession } from '../auth.js';
import { navigate } from '../router.js';

function field(label, input, hint) {
  return el('div', { class: 'field' },
    el('label', { for: input.id }, label),
    input,
    hint ? el('div', { class: 'hint' }, hint) : null,
  );
}

// ── パスワード ────────────────────────────────────────────────────────────
function renderPasswordSection() {
  const current = el('input', { type: 'password', id: 'pw-current', required: true, autocomplete: 'current-password' });
  const next = el('input', { type: 'password', id: 'pw-new', required: true, autocomplete: 'new-password' });
  const confirm = el('input', { type: 'password', id: 'pw-confirm', required: true, autocomplete: 'new-password' });
  const errorBox = el('div', { class: 'error-msg', role: 'alert' });
  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, 'パスワードを変更');

  const form = el('form', {
    class: 'stack',
    onSubmit: async (e) => {
      e.preventDefault();
      errorBox.textContent = '';
      if (next.value !== confirm.value) { fieldError(confirm, '確認用パスワードが一致しません'); return; }
      fieldError(confirm, '');
      submitBtn.disabled = true;
      try {
        await api.changePassword(current.value, next.value);
        // サーバは変更と同時に既存の全セッション（このトークンも）を失効させる。
        // ここで黙って使い続けると次の要求で 401 になるので、正直に再ログインへ。
        toast('パスワードを変更しました。新しいパスワードでログインし直してください', 'success', 6000);
        clearSession();
        navigate('#/login');
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.message : '変更に失敗しました';
        submitBtn.disabled = false;
      }
    },
  },
    field('現在のパスワード', current),
    field('新しいパスワード', next, '8文字以上、大文字・小文字・数字・記号を各1つ以上'),
    field('新しいパスワード（確認）', confirm),
    errorBox,
    submitBtn,
  );
  return el('div', { class: 'card stack password-section' }, el('h2', {}, 'パスワード'), form);
}

// ── 通知先 ────────────────────────────────────────────────────────────────
// GET は lineToken を '***' に伏せて返す。POST は設定全体を置き換えるので、
// フォームに出さない項目（イベント別 webhooks 等）は現在値をそのまま送り返す。
// '***' のままの lineToken はサーバ側で「変更なし」として扱われる。
const CHANNELS = [
  { key: 'email', label: 'メールアドレス', type: 'email', hint: '運営が SMTP を設定している場合のみ届きます' },
  { key: 'discordWebhook', label: 'Discord Webhook URL', type: 'url', hint: 'サーバー設定 → 連携サービス → ウェブフック' },
  { key: 'slackWebhook', label: 'Slack Incoming Webhook URL', type: 'url' },
  { key: 'lineToken', label: 'LINE Notify トークン', type: 'password', hint: '保存済みのトークンは *** と表示されます（そのままなら変更なし）' },
  { key: 'telegramBotToken', label: 'Telegram Bot トークン', type: 'password' },
  { key: 'telegramChatId', label: 'Telegram Chat ID', type: 'text' },
];

function renderNotificationSection(userId) {
  const box = el('div', { class: 'card stack notification-section' }, el('h2', {}, '通知先'), skeleton('line', 4));
  const inputs = {};

  async function load() {
    let current = {};
    try { current = await api.getNotificationSettings(userId); } catch (_) { current = {}; }

    const rows = CHANNELS.map((c) => {
      const input = el('input', { type: c.type, id: `notify-${c.key}`, autocomplete: 'off', value: current[c.key] || '' });
      inputs[c.key] = input;
      return field(c.label, input, c.hint);
    });
    const errorBox = el('div', { class: 'error-msg', role: 'alert' });
    const saveBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, '通知先を保存');
    const deleteBtn = el('button', {
      type: 'button', class: 'btn btn-ghost',
      onClick: async () => {
        if (!(await confirmDialog('通知先をすべて削除します。よろしいですか？'))) return;
        try {
          await api.deleteNotificationSettings(userId);
          toast('通知先を削除しました', 'info');
          await load();
        } catch (err) {
          toast(err instanceof ApiError && err.status === 404 ? '通知先は登録されていません' : '削除に失敗しました', 'error');
        }
      },
    }, '通知先をすべて削除');

    const form = el('form', {
      class: 'stack',
      onSubmit: async (e) => {
        e.preventDefault();
        errorBox.textContent = '';
        saveBtn.disabled = true;
        const body = { ...current };
        for (const c of CHANNELS) body[c.key] = inputs[c.key].value.trim();
        try {
          await api.saveNotificationSettings(userId, body);
          toast('通知先を保存しました', 'success');
          await load();
        } catch (err) {
          errorBox.textContent = err instanceof ApiError ? err.message : '保存に失敗しました';
          saveBtn.disabled = false;
        }
      },
    },
      el('p', { class: 'muted', style: 'margin:0' },
        '注文が入ったとき・支払いが確認されたとき・評価が届いたとき・ウォッチ中の GPU が値下げされたときに、ここへ通知します。空欄のチャネルには送りません。'),
      ...rows,
      errorBox,
      el('div', { class: 'row' }, saveBtn, deleteBtn),
    );
    box.replaceChildren(el('h2', {}, '通知先'), form);
  }

  load();
  return box;
}

// ── 値下げ通知中の GPU ────────────────────────────────────────────────────
function renderWatchesSection() {
  const box = el('div', { class: 'card stack watches-section' }, el('h2', {}, '値下げ通知中の GPU'), skeleton('line', 2));

  async function load() {
    let watches = [];
    try { ({ watches } = await api.myWatches()); } catch (_) { watches = []; }
    const list = watches.length
      ? el('div', { class: 'stack' }, ...watches.map((w) => {
          const removeBtn = el('button', {
            class: 'btn btn-ghost btn-sm',
            onClick: async () => {
              removeBtn.disabled = true;
              try {
                await api.removeGpuWatch(w.gpuId);
                toast('通知を解除しました', 'info');
                await load();
              } catch (err) {
                toast(err instanceof ApiError ? err.message : '解除に失敗しました', 'error');
                removeBtn.disabled = false;
              }
            },
          }, '解除');
          return el('div', { class: 'row-between watch-row' },
            el('div', {},
              w.gpu
                ? el('a', { href: `#/gpus/${w.gpuId}` }, w.gpu.name)
                : el('span', { class: 'muted' }, '（削除された GPU）'),
              el('div', { class: 'muted', style: 'font-size:0.85rem' },
                `目標 ${fmtSats(w.targetPrice)}/時${w.gpu ? `・現在 ${fmtSats(w.gpu.pricePerHour)}/時` : ''}${w.lastNotifiedAt ? `・通知済み ${fmtDate(w.lastNotifiedAt)}` : ''}`),
            ),
            removeBtn,
          );
        }))
      : el('p', { class: 'muted' }, 'GPU 詳細ページの「価格通知」から登録できます。');
    box.replaceChildren(el('h2', {}, '値下げ通知中の GPU'), list);
  }

  load();
  return box;
}

export async function render(container) {
  const user = getUser();
  container.appendChild(el('div', { class: 'stack' },
    el('h1', {}, 'アカウント'),
    el('p', { class: 'muted' }, user ? `${user.username}（${user.email || ''}）` : ''),
    renderPasswordSection(),
    renderNotificationSection(user.id),
    renderWatchesSection(),
  ));
}
