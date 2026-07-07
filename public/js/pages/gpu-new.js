// public/js/pages/gpu-new.js — provider GPU registration form.
// Field constraints mirror schemas.gpu.register in src/utils/validator.js.
import { el, fieldError, toast } from '../ui.js';
import { api, ApiError } from '../api.js';
import { navigate } from '../router.js';

const VENDORS = ['NVIDIA', 'AMD', 'Intel'];
const API_TYPES = ['CUDA', 'ROCm', 'oneAPI', 'OpenCL'];
const ARCHS = ['x86_64', 'arm64', 'aarch64', 'x86', 'arm'];

export function render(container) {
  const nameInput = el('input', { type: 'text', maxlength: '128', required: true });
  const vendorSelect = el('select', { required: true },
    el('option', { value: '' }, '選択してください'),
    ...VENDORS.map((v) => el('option', { value: v }, v)));
  const modelInput = el('input', { type: 'text', maxlength: '128', required: true });
  const apiTypeSelect = el('select', { required: true },
    el('option', { value: '' }, '選択してください'),
    ...API_TYPES.map((v) => el('option', { value: v }, v)));
  const driverInput = el('input', { type: 'text', maxlength: '64', required: true, placeholder: '例: 550.90.07' });
  const osInput = el('input', { type: 'text', maxlength: '64', required: true, placeholder: '例: Ubuntu 22.04' });
  const archSelect = el('select', { required: true },
    el('option', { value: '' }, '選択してください'),
    ...ARCHS.map((v) => el('option', { value: v }, v)));
  const memoryInput = el('input', { type: 'number', min: '1', max: '8192', required: true, placeholder: 'GB' });
  const clockInput = el('input', { type: 'number', min: '100', max: '20000', required: true, placeholder: 'MHz' });
  const powerInput = el('input', { type: 'number', min: '1', max: '20000', required: true, placeholder: 'W' });
  const priceInput = el('input', { type: 'number', min: '0.00001', max: '1000000', step: 'any', required: true, placeholder: 'sats/時' });

  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'GPUを登録する');
  const errorBox = el('p', { class: 'error-msg', style: 'display:none' });

  const field = (label, input, hint) => el('div', { class: 'field' },
    el('label', {}, label), input, hint ? el('div', { class: 'hint' }, hint) : null);

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
          apiType: apiTypeSelect.value,
          driverVersion: driverInput.value.trim(),
          os: osInput.value.trim(),
          arch: archSelect.value,
          memoryGB: Number(memoryInput.value),
          clockMHz: Number(clockInput.value),
          powerWatt: Number(powerInput.value),
          pricePerHour: Number(priceInput.value),
        };
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
      field('APIタイプ', apiTypeSelect),
    ),
    field('モデル', modelInput, '例: GeForce RTX 4090'),
    el('div', { class: 'field-row' },
      field('ドライババージョン', driverInput),
      field('OS', osInput),
    ),
    field('アーキテクチャ', archSelect),
    el('div', { class: 'field-row' },
      field('メモリ', memoryInput, 'GB単位'),
      field('クロック', clockInput, 'MHz単位'),
      field('消費電力', powerInput, 'W単位'),
    ),
    field('価格', priceInput, 'sats/時（1時間あたりの貸出料金）'),
    errorBox,
    submitBtn,
  );

  container.appendChild(
    el('div', { class: 'stack' },
      el('h1', {}, 'GPUを登録'),
      el('div', { class: 'card', style: 'max-width:640px' }, form),
    )
  );
}
