// public/js/pages/gpu-new.js — 出品フォーム。
//
// 必須は貸し手が手元で必ず答えられる 5 項目だけにする。
// 以前は 11 項目すべてが必須で、ドライババージョンやコアクロックを調べないと
// 出品できなかった。二面市場で最初に起きる行為は供給側の出品であり、ここで
// 落ちると市場そのものが立ち上がらない。残りはサーバが機種から導出するか
// （apiType / arch / 消費電力）、表示専用（ドライバ・OS・クロック）なので任意にした。
// 制約は src/utils/validator.js の schemas.gpu.register と対応している。
//
// 参考価格（2026-09 追加）: 貸し手はこれまで値段を勘で決めるしかなかった。特徴量ベースの
// 価格エンジン（src/pricing/feature-pricer.js）は実装もテストも揃っていたのに
// `POST /marketplace/quote` から呼べるだけで、UI からは一度も呼ばれておらず
// **値段を一つも決めていなかった**。ここで初めて人の目に触れる。
// 提示するのは参照表で型番が特定できたときだけにする（`basis.quotable`）。
// 未知の型番でもエンジンは VRAM だけで数字を返すが、それを「参考価格」と称するのは
// 知らないのに知っているふりをすることになる。
import { el, toast } from '../ui.js';
import { api, ApiError } from '../api.js';
import { navigate } from '../router.js';

const VENDORS = ['NVIDIA', 'AMD', 'Intel'];
const API_TYPES = ['CUDA', 'ROCm', 'oneAPI', 'OpenCL'];
const ARCHS = ['x86_64', 'arm64', 'aarch64', 'x86', 'arm'];

export function render(container) {
  // --- 必須（貸し手が見れば分かること） ---
  const nameInput = el('input', { id: 'gpu-name', type: 'text', maxlength: '128', required: true });
  const vendorSelect = el('select', { id: 'gpu-vendor', required: true },
    el('option', { value: '' }, '選択してください'),
    ...VENDORS.map((v) => el('option', { value: v }, v)));
  const modelInput = el('input', { id: 'gpu-model', type: 'text', maxlength: '128', required: true });
  const memoryInput = el('input', { id: 'gpu-memory', type: 'number', min: '1', max: '8192', required: true, placeholder: 'GB' });
  const priceInput = el('input', { id: 'gpu-price', type: 'number', min: '0.00001', max: '1000000', step: 'any', required: true, placeholder: 'sats/時' });

  // --- 任意（分かる人だけ埋めればよい） ---
  const apiTypeSelect = el('select', { id: 'gpu-apitype' },
    el('option', { value: '' }, 'ベンダーから自動判定'),
    ...API_TYPES.map((v) => el('option', { value: v }, v)));
  const archSelect = el('select', { id: 'gpu-arch' },
    el('option', { value: '' }, 'x86_64（既定）'),
    ...ARCHS.map((v) => el('option', { value: v }, v)));
  const driverInput = el('input', { id: 'gpu-driver', type: 'text', maxlength: '64', placeholder: '例: 550.90.07' });
  const osInput = el('input', { id: 'gpu-os', type: 'text', maxlength: '64', placeholder: '例: Ubuntu 22.04' });
  const clockInput = el('input', { id: 'gpu-clock', type: 'number', min: '100', max: '20000', placeholder: 'MHz' });
  const powerInput = el('input', { id: 'gpu-power', type: 'number', min: '1', max: '20000', placeholder: 'W（未入力なら機種の公称TDP）' });

  // --- 参考価格 -------------------------------------------------------------
  const suggestBox = el('div', { class: 'hint', id: 'price-suggestion' });
  let suggestSeq = 0;

  const renderSuggestion = (node) => {
    suggestBox.textContent = '';
    if (node) suggestBox.appendChild(node);
  };

  async function refreshSuggestion() {
    const vendor = vendorSelect.value;
    const model = modelInput.value.trim();
    const memoryGB = Number(memoryInput.value);
    if (!vendor || !model || !Number.isFinite(memoryGB) || memoryGB <= 0) {
      return renderSuggestion(null);
    }
    // 入力のたびに走るので、遅れて返ってきた古い応答で上書きしない。
    const seq = ++suggestSeq;
    try {
      const q = await api.quoteGpu({ vendor, model, memoryGB });
      if (seq !== suggestSeq) return;
      if (!q || !q.basis || !q.basis.quotable) {
        return renderSuggestion(el('span', { class: 'muted' },
          'この型番は参照表に無いため参考価格を出せません。'
          + '（推測で数字を出すより、出さない方が正直です）'));
      }
      const sats = Math.round(q.pricePerHour);
      renderSuggestion(el('span', {},
        `参考価格: 約 ${sats.toLocaleString()} sats/時`,
        el('button', {
          type: 'button', class: 'btn btn-link', id: 'apply-suggestion',
          style: 'margin-left:.5em',
          onClick: () => { priceInput.value = String(sats); },
        }, 'この値を使う'),
        el('div', { class: 'muted' },
          `${q.basis.matchedModel} の仕様（VRAM・帯域・世代）から算出した目安です。`
          + '実際の課金はあなたが設定した価格で行われます。'),
      ));
    } catch (_) {
      if (seq !== suggestSeq) return;
      renderSuggestion(null); // 見積が取れなくても出品は妨げない
    }
  }

  let suggestTimer = null;
  const scheduleSuggestion = () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(refreshSuggestion, 400);
  };
  vendorSelect.addEventListener('change', scheduleSuggestion);
  modelInput.addEventListener('input', scheduleSuggestion);
  memoryInput.addEventListener('input', scheduleSuggestion);

  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'GPUを登録する');
  const errorBox = el('p', { class: 'error-msg', style: 'display:none' });

  const field = (label, input, hint) => el('div', { class: 'field' },
    el('label', {}, label), input, hint ? el('div', { class: 'hint' }, hint) : null);

  // 数値の任意項目は「空欄なら送らない」。Number('') は 0 になり、0 は
  // 「消費電力 0W」という誤った申告としてサーバに保存されてしまう。
  const optionalNumber = (input) => {
    const raw = input.value.trim();
    if (raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const optionalText = (input) => {
    const raw = input.value.trim();
    return raw === '' ? undefined : raw;
  };

  const details = el('details', { class: 'optional-specs' },
    el('summary', {}, '詳細スペック（任意）'),
    el('p', { class: 'hint' },
      '未入力の項目はサーバが機種から補います。補った値は一覧・詳細で「推定」と表示され、'
      + '申告した値と混同されません。'),
    el('div', { class: 'field-row' },
      field('APIタイプ', apiTypeSelect),
      field('アーキテクチャ', archSelect),
    ),
    el('div', { class: 'field-row' },
      field('ドライババージョン', driverInput),
      field('OS', osInput),
    ),
    el('div', { class: 'field-row' },
      field('クロック', clockInput, 'MHz単位'),
      field('消費電力', powerInput, 'W単位'),
    ),
  );

  const form = el('form', {
    class: 'stack',
    onSubmit: async (e) => {
      e.preventDefault();
      errorBox.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.textContent = '登録中…';
      try {
        const payload = {
          name: nameInput.value.trim(),
          vendor: vendorSelect.value,
          model: modelInput.value.trim(),
          memoryGB: Number(memoryInput.value),
          pricePerHour: Number(priceInput.value),
        };
        const optional = {
          apiType: apiTypeSelect.value || undefined,
          arch: archSelect.value || undefined,
          driverVersion: optionalText(driverInput),
          os: optionalText(osInput),
          clockMHz: optionalNumber(clockInput),
          powerWatt: optionalNumber(powerInput),
        };
        for (const [k, v] of Object.entries(optional)) {
          if (v !== undefined) payload[k] = v;
        }
        await api.createGpu(payload);
        toast('GPUを登録しました', 'success');
        navigate('#/my-gpus');
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.message : '通信エラーが発生しました';
        errorBox.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'GPUを登録する';
      }
    },
  },
    field('GPU名', nameInput),
    el('div', { class: 'field-row' },
      field('ベンダー', vendorSelect),
      field('モデル', modelInput, '例: GeForce RTX 4090'),
    ),
    el('div', { class: 'field-row' },
      field('メモリ', memoryInput, 'GB単位'),
      field('価格', priceInput, 'sats/時（1時間あたりの貸出料金）'),
    ),
    suggestBox,
    details,
    errorBox,
    submitBtn,
  );

  container.appendChild(
    el('div', { class: 'stack' },
      el('h1', {}, 'GPUを登録'),
      el('p', { class: 'muted' }, '必要なのは 5 項目だけです。詳細スペックは分かる範囲で構いません。'),
      el('div', { class: 'card', style: 'max-width:640px' }, form),
    )
  );
}
